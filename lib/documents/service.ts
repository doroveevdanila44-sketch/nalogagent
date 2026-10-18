import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { PeriodError, formatPeriod, type Period } from '@/lib/calc/period';
import { CalcInputError } from '@/lib/calc/service';
import { momentFromEpoch } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import {
  documentComments,
  documentEvents,
  documentTemplates,
  documentVersions,
  documents,
  legalEntities,
  people,
} from '@/lib/db/schema';
import { runQueries } from '@/lib/provenance/schemas';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import type { DocumentDetail } from './detail';
import {
  FieldError,
  applyEdits,
  fillFields,
  missingKeys,
  templateQueries,
  type EntityData,
} from './fill';
import { documentFileName, mimeOf } from './file-name';
import { isUuid, isVersionNumber } from './ids';
import { buildDeclarationXlsx, buildDocx } from './files';
import { renderBlocks } from './render';
import {
  STATUS_LABEL,
  type CommentInfo,
  type DocStatus,
  type DocumentSummary,
  type EntityRequisites,
  type EventInfo,
  type FieldValues,
  type TemplateCategory,
  type TemplateDef,
  type TemplateField,
  type VersionChange,
  type VersionInfo,
} from './types';
import { REVIEWER_IDS, WorkflowError, actionsFor, transition } from './workflow';

export class DocError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 422,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DocError';
  }
}

const OWNER = 'Владелец';

// ===== Каталог =====

function toTemplate(r: typeof documentTemplates.$inferSelect): TemplateDef {
  return {
    key: r.key,
    category: r.category as TemplateCategory,
    title: r.title,
    description: r.description,
    body: r.body,
    fields: r.fields as TemplateField[],
    scope: r.scope === 'group' ? 'group' : 'entity',
    needsPeriod: r.needsPeriod,
    output: r.output === 'xlsx' ? 'xlsx' : 'docx',
    taxes: r.taxes as TemplateDef['taxes'],
    sort: r.sort,
  };
}

export async function listTemplates(db: Db): Promise<TemplateDef[]> {
  const rows = await db.select().from(documentTemplates).orderBy(asc(documentTemplates.sort), asc(documentTemplates.key));
  return rows.map(toTemplate);
}

async function getTemplate(db: Db, key: string): Promise<TemplateDef> {
  const [row] = await db.select().from(documentTemplates).where(eq(documentTemplates.key, key)).limit(1);
  if (!row) throw new DocError(404, 'template', 'Шаблон не найден');
  return toTemplate(row);
}

/** Реквизиты без пометок «(демо)»: значения попадают в текст документа, метка «Демо-данные» одна, в шапке. */
function cleanRequisites(r: EntityRequisites | null): EntityRequisites | null {
  if (!r) return r;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = typeof v === 'string' ? v.replace(/\s*\((?:вымышленные,\s*)?демо\)/gi, '').trim() : v;
  }
  return out as unknown as EntityRequisites;
}

async function loadEntity(db: Db, id: string): Promise<EntityData> {
  const [row] = await db.select().from(legalEntities).where(eq(legalEntities.id, id)).limit(1);
  if (!row) throw new DocError(404, 'entity', 'Юрлицо не найдено');
  return {
    id: row.id,
    name: row.name,
    form: row.form,
    requisites: cleanRequisites((row.requisites as EntityRequisites | null) ?? null),
  };
}

// ===== Вспомогательное =====

/** Стабильная запись объекта: ключи по алфавиту, чтобы хэш не зависел от порядка. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

export function versionHash(body: string, values: FieldValues, calc: CalcSnapshot[]): string {
  return createHash('sha256').update(stable({ body, values, calc })).digest('hex');
}

const PERIOD_KINDS = new Set(['month', 'quarter', 'year', 'ytd']);

function checkPeriod(t: TemplateDef, period: Period | null | undefined): Period | null {
  if (!t.needsPeriod) return null;
  if (!period || !PERIOD_KINDS.has(period.kind)) {
    throw new DocError(422, 'period', 'Для этого шаблона нужен период: месяц, квартал, год или с начала года');
  }
  return period;
}

async function calcFor(
  db: Db,
  t: Pick<TemplateDef, 'fields' | 'taxes' | 'scope' | 'needsPeriod'>,
  args: { entityId: string | null; period: Period | null; nowMs: number; tz: string },
): Promise<CalcSnapshot[]> {
  const queries = templateQueries(t, { entityId: args.entityId, period: args.period });
  if (queries.length === 0) return [];
  try {
    const data = await loadCalcData(db, momentFromEpoch(args.nowMs, args.tz));
    return runQueries(data, queries, { at: args.nowMs, tz: args.tz });
  } catch (e) {
    if (e instanceof CalcInputError || e instanceof PeriodError) throw new DocError(422, 'calc', e.message);
    throw e;
  }
}

function userValues(fields: TemplateField[], values: FieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v?.source === 'user' && v.value) out[f.key] = v.value;
  }
  return out;
}

function diff(fields: TemplateField[], prev: FieldValues, next: FieldValues): VersionChange[] {
  const out: VersionChange[] = [];
  for (const f of fields) {
    const a = prev[f.key]?.display ?? null;
    const b = next[f.key]?.display ?? null;
    if (a !== b) out.push({ field: f.key, label: f.label, from: a, to: b });
  }
  return out;
}

function shortTitle(t: TemplateDef, entity: EntityData | null, period: Period | null): string {
  const parts: string[] = [t.title];
  if (entity) parts.push(entity.name);
  if (period) parts.push(formatPeriod(period));
  return parts.join(', ');
}

async function event(
  db: Db,
  documentId: string,
  e: { kind: string; versionN?: number | null; actor: string; data?: Record<string, unknown> },
) {
  await db.insert(documentEvents).values({
    documentId,
    kind: e.kind,
    versionN: e.versionN ?? null,
    actor: e.actor,
    data: e.data ?? {},
  });
}

async function ownDocument(db: Db, userId: string, id: string) {
  if (!isUuid(id)) throw new DocError(404, 'not_found', 'Документ не найден');
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.createdBy, userId), isNull(documents.deletedAt)))
    .limit(1);
  if (!doc) throw new DocError(404, 'not_found', 'Документ не найден');
  return doc;
}

/** Сколько после мягкого удаления черновик можно вернуть; потом он стирается окончательно. */
export const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Окончательно удаляет черновики, которые лежат в удалённых больше суток. Версии, комментарии и
 * лента событий уходят вместе с документом (внешние ключи с каскадом). Фоновых задач в приложении
 * нет, поэтому очистка идёт при каждом чтении списка и при удалении: просроченное исчезает при
 * ближайшем обращении, а на экране удалённых документов и так не видно.
 */
export async function purgeDeleted(db: Db, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - RESTORE_WINDOW_MS);
  const gone = await db
    .delete(documents)
    .where(and(isNotNull(documents.deletedAt), lt(documents.deletedAt, cutoff)))
    .returning({ id: documents.id });
  return gone.length;
}

/**
 * Удаляет черновики (мягко: поле deleted_at). Документы на проверке, с замечаниями, согласованные
 * и отозванные не удаляются: проверка идёт по всем сразу, при первом неподходящем ничего не меняется.
 */
export async function deleteDocuments(
  db: Db,
  args: { userId: string; ids: string[]; nowMs: number },
): Promise<string[]> {
  const ids = [...new Set(args.ids)];
  const rows = [];
  for (const id of ids) rows.push(await ownDocument(db, args.userId, id));
  const bad = rows.find((d) => d.status !== 'draft');
  if (bad) {
    const word = bad.status === 'review' ? 'Документ на проверке: сначала отзовите его' : 'Удалить можно только черновик';
    throw new DocError(409, 'not_draft', word, { id: bad.id, status: bad.status });
  }
  if (ids.length > 0) {
    await db
      .update(documents)
      .set({ deletedAt: new Date(args.nowMs) })
      .where(and(inArray(documents.id, ids), eq(documents.createdBy, args.userId)));
  }
  await purgeDeleted(db, args.nowMs);
  return ids;
}

/** Возвращает удалённые черновики, пока не прошли сутки («Отменить» в уведомлении). */
export async function restoreDocuments(
  db: Db,
  args: { userId: string; ids: string[]; nowMs: number },
): Promise<string[]> {
  const ids = [...new Set(args.ids)];
  if (ids.length === 0) return [];
  if (!ids.every(isUuid)) throw new DocError(404, 'not_found', 'Документ не найден');
  const cutoff = new Date(args.nowMs - RESTORE_WINDOW_MS);
  const back = await db
    .update(documents)
    .set({ deletedAt: null })
    .where(
      and(
        inArray(documents.id, ids),
        eq(documents.createdBy, args.userId),
        isNotNull(documents.deletedAt),
        // удалённый позже границы ещё не стёрт
        sql`${documents.deletedAt} >= ${cutoff}`,
      ),
    )
    .returning({ id: documents.id });
  if (back.length === 0) throw new DocError(404, 'not_found', 'Документ не найден');
  return back.map((r) => r.id);
}

async function versionRow(db: Db, documentId: string, n: number) {
  if (!isVersionNumber(n)) throw new DocError(404, 'version', 'Версия не найдена');
  const [v] = await db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.n, n)))
    .limit(1);
  if (!v) throw new DocError(404, 'version', 'Версия не найдена');
  return v;
}

// ===== Создание и правка =====

export async function createDocument(
  db: Db,
  args: {
    userId: string;
    templateKey: string;
    entityId?: string | null;
    period?: Period | null;
    user?: Record<string, string>;
    nowMs: number;
    tz: string;
  },
): Promise<string> {
  const t = await getTemplate(db, args.templateKey);
  let entity: EntityData | null = null;
  if (t.scope === 'entity') {
    if (!args.entityId) throw new DocError(422, 'entity', 'Выберите юрлицо');
    entity = await loadEntity(db, args.entityId);
  }
  const period = checkPeriod(t, args.period);
  const snaps = await calcFor(db, t, { entityId: entity?.id ?? null, period, nowMs: args.nowMs, tz: args.tz });

  let values: FieldValues;
  try {
    values = fillFields(t.fields, { entity, snaps, user: args.user ?? {} });
  } catch (e) {
    if (e instanceof FieldError) throw new DocError(422, 'field', e.message, { field: e.field });
    throw e;
  }

  const hash = versionHash(t.body, values, snaps);
  const title = shortTitle(t, entity, period);
  const id = await db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        templateKey: t.key,
        title,
        entityId: entity?.id ?? null,
        period,
        status: 'draft',
        currentVersion: 1,
        createdBy: args.userId,
        createdAt: new Date(args.nowMs),
        updatedAt: new Date(args.nowMs),
      })
      .returning({ id: documents.id });
    await tx.insert(documentVersions).values({
      documentId: doc!.id,
      n: 1,
      body: t.body,
      fields: t.fields,
      values,
      calc: snaps,
      changes: [{ field: 'created', label: 'Документ создан из шаблона', from: null, to: null }],
      authorId: args.userId,
      authorName: OWNER,
      hash,
      createdAt: new Date(args.nowMs),
    });
    await tx.insert(documentEvents).values({
      documentId: doc!.id,
      kind: 'created',
      versionN: 1,
      actor: OWNER,
      data: { template: t.title },
      createdAt: new Date(args.nowMs),
    });
    return doc!.id;
  });
  return id;
}

/**
 * Новая версия по правкам. Версия не меняется на месте: создаётся следующая, документ возвращается
 * в «Черновик». Согласованный документ править можно только так же, новой версией; на проверке
 * править нельзя, документ сначала отзывают.
 */
export async function saveVersion(
  db: Db,
  args: {
    userId: string;
    id: string;
    baseVersion: number;
    edits: Record<string, string>;
    refreshCalc?: boolean;
    nowMs: number;
    tz: string;
  },
): Promise<{ version: number; status: DocStatus; changes: VersionChange[] }> {
  const doc = await ownDocument(db, args.userId, args.id);
  const status = doc.status as DocStatus;
  let next: DocStatus;
  try {
    next = transition(status, 'edit');
  } catch (e) {
    if (e instanceof WorkflowError) throw new DocError(409, e.code, e.message);
    throw e;
  }
  if (args.baseVersion !== doc.currentVersion) {
    throw new DocError(409, 'stale', 'Документ уже изменился. Обновите страницу, чтобы увидеть нынешнюю версию');
  }
  const prev = await versionRow(db, doc.id, doc.currentVersion);
  const fields = prev.fields as TemplateField[];
  const prevValues = prev.values as FieldValues;
  let values = prevValues;
  let calc = prev.calc as CalcSnapshot[];
  const changes: VersionChange[] = [];

  try {
    if (args.refreshCalc) {
      const t = await getTemplate(db, doc.templateKey);
      const entity = doc.entityId ? await loadEntity(db, doc.entityId) : null;
      calc = await calcFor(db, { ...t, fields }, {
        entityId: doc.entityId,
        period: (doc.period as Period | null) ?? null,
        nowMs: args.nowMs,
        tz: args.tz,
      });
      values = fillFields(fields, { entity, snaps: calc, user: userValues(fields, prevValues) });
    }
    const applied = applyEdits(fields, values, args.edits);
    values = applied.values;
  } catch (e) {
    if (e instanceof FieldError) throw new DocError(422, 'field', e.message, { field: e.field });
    throw e;
  }

  changes.push(...diff(fields, prevValues, values));
  if (args.refreshCalc) {
    changes.unshift({ field: 'calc', label: 'Расчёт обновлён по актуальным данным', from: null, to: null });
  }
  if (changes.length === 0) throw new DocError(409, 'no_changes', 'Изменений нет, новая версия не создана');

  const n = doc.currentVersion + 1;
  const hash = versionHash(prev.body, values, calc);
  await db.transaction(async (tx) => {
    await tx.insert(documentVersions).values({
      documentId: doc.id,
      n,
      body: prev.body,
      fields,
      values,
      calc,
      changes,
      authorId: args.userId,
      authorName: OWNER,
      hash,
      createdAt: new Date(args.nowMs),
    });
    await tx
      .update(documents)
      .set({ status: next, currentVersion: n, updatedAt: new Date(args.nowMs) })
      .where(eq(documents.id, doc.id));
    await tx.insert(documentEvents).values({
      documentId: doc.id,
      kind: 'version',
      versionN: n,
      actor: OWNER,
      data: { changes: changes.length, fromStatus: status, toStatus: next },
      createdAt: new Date(args.nowMs),
    });
  });
  return { version: n, status: next, changes };
}

// ===== Согласование =====

export async function submitDocument(
  db: Db,
  args: { userId: string; id: string; recipientId: string; comment: string; nowMs: number },
): Promise<void> {
  const doc = await ownDocument(db, args.userId, args.id);
  const status = doc.status as DocStatus;
  let next: DocStatus;
  try {
    next = transition(status, 'submit');
  } catch (e) {
    if (e instanceof WorkflowError) throw new DocError(409, e.code, e.message);
    throw e;
  }
  if (!(REVIEWER_IDS as readonly string[]).includes(args.recipientId)) {
    throw new DocError(422, 'recipient', 'Получатель: бухгалтер или финансовый директор');
  }
  const [person] = await db.select().from(people).where(eq(people.id, args.recipientId)).limit(1);
  if (!person) throw new DocError(404, 'recipient', 'Получатель не найден в справочнике');

  const v = await versionRow(db, doc.id, doc.currentVersion);
  const missing = missingKeys(v.fields as TemplateField[], v.values as FieldValues);
  if (missing.length > 0) {
    throw new DocError(422, 'incomplete', 'Заполните обязательные поля, затем отправляйте на проверку', { missing });
  }
  const when = new Date(args.nowMs);
  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ status: next, reviewerId: person.id, updatedAt: when })
      .where(eq(documents.id, doc.id));
    await tx.insert(documentEvents).values({
      documentId: doc.id,
      kind: 'submitted',
      versionN: doc.currentVersion,
      actor: OWNER,
      data: { recipient: `${person.name}, ${person.role}`, comment: args.comment, demo: true },
      createdAt: when,
    });
    if (args.comment) {
      await tx.insert(documentComments).values({
        documentId: doc.id,
        versionN: doc.currentVersion,
        fieldKey: null,
        kind: 'comment',
        body: args.comment,
        authorUserId: args.userId,
        authorName: OWNER,
        createdAt: when,
      });
    }
  });
}

export async function withdrawDocument(db: Db, args: { userId: string; id: string; nowMs: number }): Promise<void> {
  const doc = await ownDocument(db, args.userId, args.id);
  let next: DocStatus;
  try {
    next = transition(doc.status as DocStatus, 'withdraw');
  } catch (e) {
    if (e instanceof WorkflowError) throw new DocError(409, e.code, e.message);
    throw e;
  }
  await db.transaction(async (tx) => {
    await tx.update(documents).set({ status: next, updatedAt: new Date(args.nowMs) }).where(eq(documents.id, doc.id));
    await tx.insert(documentEvents).values({
      documentId: doc.id,
      kind: 'withdrawn',
      versionN: doc.currentVersion,
      actor: OWNER,
      data: { fromStatus: doc.status },
      createdAt: new Date(args.nowMs),
    });
  });
}

export async function addComment(
  db: Db,
  args: { userId: string; id: string; fieldKey: string | null; body: string; nowMs: number },
): Promise<CommentInfo> {
  const doc = await ownDocument(db, args.userId, args.id);
  const body = args.body.trim();
  if (body.length === 0 || body.length > 1000) throw new DocError(422, 'comment', 'Комментарий от 1 до 1000 знаков');
  if (args.fieldKey !== null) {
    const v = await versionRow(db, doc.id, doc.currentVersion);
    const known = (v.fields as TemplateField[]).some((f) => f.key === args.fieldKey);
    if (!known && !/^b\d{1,4}$/.test(args.fieldKey)) {
      throw new DocError(422, 'field', 'Такого поля или абзаца в документе нет');
    }
  }
  const when = new Date(args.nowMs);
  const [row] = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(documentComments)
      .values({
        documentId: doc.id,
        versionN: doc.currentVersion,
        fieldKey: args.fieldKey,
        kind: 'comment',
        body,
        authorUserId: args.userId,
        authorName: OWNER,
        createdAt: when,
      })
      .returning();
    await tx.insert(documentEvents).values({
      documentId: doc.id,
      kind: 'comment',
      versionN: doc.currentVersion,
      actor: OWNER,
      data: { field: args.fieldKey, text: body },
      createdAt: when,
    });
    return rows;
  });
  return toComment(row!);
}

export async function resolveComment(
  db: Db,
  args: { userId: string; id: string; commentId: number; resolved: boolean; nowMs: number },
): Promise<void> {
  const doc = await ownDocument(db, args.userId, args.id);
  const res = await db
    .update(documentComments)
    .set({ resolved: args.resolved, resolvedAt: args.resolved ? new Date(args.nowMs) : null })
    .where(and(eq(documentComments.id, args.commentId), eq(documentComments.documentId, doc.id)))
    .returning({ id: documentComments.id });
  if (res.length === 0) throw new DocError(404, 'comment', 'Комментарий не найден');
  if (args.resolved) {
    await event(db, doc.id, { kind: 'resolved', versionN: doc.currentVersion, actor: OWNER, data: { comment: args.commentId } });
  }
}

const DEMO_COMMENTS = [
  'Реквизиты и суммы в документе просмотрел, вопросов к ним нет.',
  'Проверил подстановку полей, расхождений с расчётом не вижу.',
];

/**
 * Демо: имитация ответа бухгалтера, чтобы заказчик прошёл весь процесс. Работает только пока
 * документ на проверке, помечена «Демо» в комментарии и в ленте; настоящего ответа не существует.
 */
export async function simulateReply(
  db: Db,
  args: { userId: string; id: string; kind: 'comment' | 'remark' | 'approve'; nowMs: number },
): Promise<DocStatus> {
  const doc = await ownDocument(db, args.userId, args.id);
  const status = doc.status as DocStatus;
  if (status !== 'review') {
    throw new DocError(409, 'bad_transition', 'Ответ имитируется только для документа на проверке');
  }
  const [person] = await db
    .select()
    .from(people)
    .where(eq(people.id, doc.reviewerId ?? 'demo-accountant'))
    .limit(1);
  const who = person ? `${person.name}, ${person.role}` : 'Бухгалтер';
  const v = await versionRow(db, doc.id, doc.currentVersion);
  const fields = v.fields as TemplateField[];
  const values = v.values as FieldValues;
  const when = new Date(args.nowMs);

  let kind: 'comment' | 'remark' | 'approval' = 'comment';
  let body = DEMO_COMMENTS[0]!;
  let fieldKey: string | null = null;
  let next: DocStatus = status;
  if (args.kind === 'remark') {
    kind = 'remark';
    const target = fields.find((f) => f.source === 'calc' && f.type === 'money' && values[f.key]?.value) ?? fields[0];
    fieldKey = target?.key ?? null;
    body = `Проверьте поле «${target?.label ?? 'документ'}»: нужна сверка с первичными документами, затем отправьте на проверку заново.`;
    next = transition(status, 'remark');
  } else if (args.kind === 'approve') {
    kind = 'approval';
    body = 'Документ проверен, замечаний нет. Согласовано.';
    next = transition(status, 'approve');
  } else {
    body = DEMO_COMMENTS[doc.currentVersion % DEMO_COMMENTS.length]!;
  }

  await db.transaction(async (tx) => {
    await tx.insert(documentComments).values({
      documentId: doc.id,
      versionN: doc.currentVersion,
      fieldKey,
      kind,
      body,
      authorPersonId: person?.id ?? null,
      authorName: `${who} (имитация)`,
      isDemo: true,
      createdAt: when,
    });
    if (next !== status) {
      await tx.update(documents).set({ status: next, updatedAt: when }).where(eq(documents.id, doc.id));
    }
    await tx.insert(documentEvents).values({
      documentId: doc.id,
      kind: kind === 'approval' ? 'approval' : kind === 'remark' ? 'remark' : 'comment',
      versionN: doc.currentVersion,
      actor: `${who} (имитация)`,
      data: { text: body, field: fieldKey, demo: true },
      createdAt: when,
    });
  });
  return next;
}

// ===== Чтение =====

function toComment(r: typeof documentComments.$inferSelect): CommentInfo {
  return {
    id: r.id,
    versionN: r.versionN,
    fieldKey: r.fieldKey,
    kind: r.kind as CommentInfo['kind'],
    body: r.body,
    // ответы, записанные прежней версией, подписаны «(демо)»: на экране «(имитация)»
    authorName: r.authorName.replace(/\(демо\)/gi, '(имитация)'),
    isDemo: r.isDemo,
    resolved: r.resolved,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listDocuments(db: Db, userId: string, nowMs: number = Date.now()): Promise<DocumentSummary[]> {
  await purgeDeleted(db, nowMs);
  const rows = await db
    .select({ d: documents, t: documentTemplates, e: legalEntities })
    .from(documents)
    .innerJoin(documentTemplates, eq(documentTemplates.key, documents.templateKey))
    .leftJoin(legalEntities, eq(legalEntities.id, documents.entityId))
    .where(and(eq(documents.createdBy, userId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(200);
  const out: DocumentSummary[] = [];
  for (const { d, t, e } of rows) {
    const v = await versionRow(db, d.id, d.currentVersion);
    const period = d.period as Period | null;
    out.push({
      id: d.id,
      templateKey: d.templateKey,
      title: d.title,
      category: t.category as TemplateCategory,
      status: d.status as DocStatus,
      version: d.currentVersion,
      entityId: d.entityId,
      entityName: e?.name ?? null,
      periodLabel: period ? formatPeriod(period) : null,
      missing: missingKeys(v.fields as TemplateField[], v.values as FieldValues).length,
      output: t.output === 'xlsx' ? 'xlsx' : 'docx',
      updatedAt: d.updatedAt.toISOString(),
    });
  }
  return out;
}

function sourceTexts(
  fields: TemplateField[],
  values: FieldValues,
  snaps: CalcSnapshot[],
  entity: EntityData | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (!v) continue;
    if (v.source === 'entity') {
      out[f.key] = `Реквизиты юрлица: ${entity?.name ?? 'справочник'}`;
    } else if (v.source === 'calc') {
      const s = v.calc ? snaps[v.calc.index] : undefined;
      const step = v.calc?.step ? s?.steps.find((x) => x.id === v.calc!.step) : undefined;
      out[f.key] = s
        ? `Расчёт: ${s.taxName}, ${s.periodLabel}${step ? `, шаг ${step.id}: ${step.text}` : ''}`
        : 'Расчёт';
    } else {
      out[f.key] = 'Введено вручную';
    }
  }
  return out;
}

export async function getDocument(
  db: Db,
  args: { userId: string; id: string; version?: number | null; tz: string },
): Promise<DocumentDetail> {
  const doc = await ownDocument(db, args.userId, args.id);
  const shown = args.version && args.version >= 1 ? args.version : doc.currentVersion;
  const v = await versionRow(db, doc.id, shown);
  const [tpl] = await db.select().from(documentTemplates).where(eq(documentTemplates.key, doc.templateKey)).limit(1);
  const entity = doc.entityId ? await loadEntity(db, doc.entityId) : null;
  const fields = v.fields as TemplateField[];
  const values = v.values as FieldValues;
  const snaps = v.calc as CalcSnapshot[];

  const [versions, comments, events] = await Promise.all([
    db.select().from(documentVersions).where(eq(documentVersions.documentId, doc.id)).orderBy(desc(documentVersions.n)),
    db.select().from(documentComments).where(eq(documentComments.documentId, doc.id)).orderBy(asc(documentComments.createdAt), asc(documentComments.id)),
    db.select().from(documentEvents).where(eq(documentEvents.documentId, doc.id)).orderBy(desc(documentEvents.createdAt), desc(documentEvents.id)),
  ]);
  const reviewer = doc.reviewerId
    ? (await db.select().from(people).where(eq(people.id, doc.reviewerId)).limit(1))[0]
    : undefined;
  const status = doc.status as DocStatus;
  const readOnly = shown !== doc.currentVersion;
  const acts = actionsFor(status);
  const period = (doc.period as Period | null) ?? null;
  const output: 'docx' | 'xlsx' = tpl?.output === 'xlsx' ? 'xlsx' : 'docx';

  return {
    id: doc.id,
    templateKey: doc.templateKey,
    title: doc.title,
    category: (tpl?.category ?? 'report') as TemplateCategory,
    status,
    version: doc.currentVersion,
    shownVersion: shown,
    entityId: doc.entityId,
    entityName: entity?.name ?? null,
    period,
    periodLabel: period ? formatPeriod(period) : null,
    output,
    fileName: documentFileName(doc.title, output, readOnly ? shown : null),
    updatedAt: (readOnly ? v.createdAt : doc.updatedAt).toISOString(),
    fields,
    values,
    blocks: renderBlocks(v.body, fields, values, snaps, doc.entityId ? 'entity' : 'group'),
    sources: sourceTexts(fields, values, snaps, entity),
    hash: v.hash,
    missing: missingKeys(fields, values),
    calcCount: snaps.length,
    versions: versions.map(
      (r): VersionInfo => ({
        n: r.n,
        authorName: r.authorName,
        createdAt: r.createdAt.toISOString(),
        changes: r.changes as VersionChange[],
        hash: r.hash,
      }),
    ),
    comments: comments.map(toComment),
    events: events.map(
      (r): EventInfo => ({
        id: r.id,
        kind: r.kind,
        versionN: r.versionN,
        actor: r.actor.replace(/\(демо\)/gi, '(имитация)'),
        data: r.data as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      }),
    ),
    reviewer: reviewer ? { id: reviewer.id, name: reviewer.name, role: reviewer.role } : null,
    can: readOnly ? { edit: false, submit: false, withdraw: false, simulate: false } : acts,
    tz: args.tz,
    readOnly,
  };
}

/** Снимки расчёта версии: по ним «Показать расчёт», Excel и проверка из документа. */
export async function documentSnapshots(
  db: Db,
  args: { userId: string; id: string; version?: number | null },
): Promise<CalcSnapshot[]> {
  const doc = await ownDocument(db, args.userId, args.id);
  const v = await versionRow(db, doc.id, args.version ?? doc.currentVersion);
  const snaps = v.calc as CalcSnapshot[];
  if (snaps.length === 0) throw new DocError(404, 'no_calc', 'В документе нет расчёта');
  return snaps;
}

// ===== Файл =====

export interface DocumentFile {
  name: string;
  mime: string;
  file: Buffer;
  kind: 'docx' | 'xlsx';
  /** Номер версии, из которой собран файл */
  version: number;
}

/**
 * Файл версии документа. Без номера версии это нынешняя версия. Имя файла: название документа и
 * расширение; для версии из истории к имени добавляется « (версия N)».
 */
export async function downloadDocument(
  db: Db,
  args: { userId: string; id: string; version?: number | null; tz: string },
): Promise<DocumentFile> {
  const doc = await ownDocument(db, args.userId, args.id);
  const n = args.version && args.version >= 1 ? args.version : doc.currentVersion;
  const v = await versionRow(db, doc.id, n);
  const [tpl] = await db.select().from(documentTemplates).where(eq(documentTemplates.key, doc.templateKey)).limit(1);
  const fields = v.fields as TemplateField[];
  const values = v.values as FieldValues;
  const snaps = v.calc as CalcSnapshot[];
  const blocks = renderBlocks(v.body, fields, values, snaps, doc.entityId ? 'entity' : 'group');
  const meta = {
    title: doc.title,
    version: n,
    hash: v.hash,
    at: snaps[0]?.at ?? v.createdAt.getTime(),
    tz: args.tz,
  };
  const kind: 'docx' | 'xlsx' = tpl?.output === 'xlsx' ? 'xlsx' : 'docx';
  const file = kind === 'xlsx' ? await buildDeclarationXlsx(blocks, snaps, meta) : await buildDocx(blocks, meta);
  return {
    name: documentFileName(doc.title, kind, n === doc.currentVersion ? null : n),
    mime: mimeOf(kind),
    file,
    kind,
    version: n,
  };
}

export { STATUS_LABEL };
