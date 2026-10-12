import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { SaxesParser } from 'saxes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown, user: '' }));
vi.mock('@/lib/db/client', () => ({ getDb: () => h.db, closeDb: async () => undefined }));
vi.mock('@/lib/auth/server', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireApiAuth: async () => ({ ok: true, auth: { userId: h.user } }),
    json: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    failure: (_scope: string, e: unknown) => {
      throw e;
    },
  };
});

import * as versionsRoute from '@/app/api/documents/[id]/versions/route';
import { GET as docGet } from '@/app/api/documents/[id]/route';
import { GET as downloadGet } from '@/app/api/documents/[id]/download/route';
import { GET as fileGet } from '@/app/api/documents/[id]/file/route';
import { POST as createPost, GET as listGet } from '@/app/api/documents/route';
import { POST as simulatePost } from '@/app/api/documents/[id]/simulate/route';
import { POST as submitPost } from '@/app/api/documents/[id]/submit/route';
import { POST as suggestPost } from '@/app/api/documents/[id]/suggest/route';
import { POST as calcPost } from '@/app/api/calc/route';
import { handleChat } from '@/lib/agent/service';
import { createOwner } from '@/lib/auth/service';
import { calcTax } from '@/lib/calc/service';
import { momentFromEpoch } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import { documentComments, documentEvents, documentTemplates, documentVersions, documents, legalEntities, users } from '@/lib/db/schema';
import { SEED_REQUISITES, seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import {
  addComment,
  createDocument,
  DocError,
  downloadDocument,
  getDocument,
  listDocuments,
  resolveComment,
  saveVersion,
  simulateReply,
  submitDocument,
  withdrawDocument,
} from './service';
import { FieldError, fillFields, missingKeys, normalizeInput, templateQueries, unfilledText } from './fill';
import { DOCX_MIME, XLSX_MIME, contentDisposition, documentFileName } from './file-name';
import { buildDocx } from './files';
import { gridRows, renderBlocks, type RenderBlock } from './render';
import { MONTH_WORDS, sanitizeSuggestions } from './suggest';
import { TEMPLATES } from './templates';
import { CATEGORIES, SAMPLE_NOTE, STATUS_LABEL, type FieldValues, type TemplateField } from './types';
import { actionsFor, transition, WorkflowError } from './workflow';

const TZ = 'Asia/Kamchatka';
const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);
const feb = { kind: 'month', year: 2026, month: 2 } as const;
/** Неразрывные пробелы формата ru-RU сводим к обычным. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  await seedDatabase(db, { tz: TZ });
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
  h.user = userId;
});
afterAll(async () => close());

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const create = (templateKey: string, extra: Record<string, unknown> = {}) =>
  createDocument(db, { userId, templateKey, nowMs: NOW, tz: TZ, ...extra } as Parameters<typeof createDocument>[1]);

async function data() {
  return loadCalcData(db, momentFromEpoch(NOW, TZ));
}

/** Полностью заполненная справка: период февраль, юрлицо Альфа, подготовил. */
const makeCertificate = () =>
  create('report_vat_certificate', { entityId: 'alfa', period: feb, user: { prepared_by: 'Образцов О.И.' } });

/** Блоки тела нынешней версии: из них строятся и .docx, и .xlsx (на странице их больше нет). */
async function blocksOf(id: string): Promise<RenderBlock[]> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  const [v] = await db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, id), eq(documentVersions.n, doc!.currentVersion)));
  return renderBlocks(
    v!.body,
    v!.fields as TemplateField[],
    v!.values as FieldValues,
    v!.calc as CalcSnapshot[],
    doc!.entityId ? 'entity' : 'group',
  );
}

describe('каталог и справочник реквизитов (сид)', () => {
  it('восемь шаблонов четырёх категорий, у каждого пометка образца в типах', async () => {
    const rows = await db.select().from(documentTemplates);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(CATEGORIES));
    expect(rows.map((r) => r.key).sort()).toEqual(TEMPLATES.map((t) => t.key).sort());
    expect(SAMPLE_NOTE).toBe('Образец, проверить юристом');
    // у каждого шаблона поля с ключом, подписью, типом, источником и признаком обязательности
    for (const t of TEMPLATES) {
      for (const f of t.fields) {
        expect(f.key).toMatch(/^[a-z0-9_]+$/);
        expect(['entity', 'calc', 'user']).toContain(f.source);
        expect(typeof f.required).toBe('boolean');
        expect(f.label.length).toBeGreaterThan(2);
      }
      // каждое поле тела описано, каждое описанное поле встречается в теле
      const used = [...t.body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
      const keys = new Set(t.fields.map((f) => f.key));
      for (const u of used) expect(keys.has(u), `${t.key}: поле ${u} не описано`).toBe(true);
      // договоры и допсоглашения: ни одного из calc-полей без налога расчёта
      expect(t.body).not.toMatch(/[\u2012-\u2015]/);
    }
    expect(TEMPLATES.filter((t) => t.output === 'xlsx').map((t) => t.category)).toEqual(['declaration', 'declaration']);
  });

  it('реквизиты юрлиц вымышленные и помечены демо', async () => {
    const rows = await db.select().from(legalEntities);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      const q = r.requisites as { demo?: boolean; inn?: string; address?: string };
      expect(q.demo).toBe(true);
      expect(q.inn).toMatch(/^99/); // региона 99 нет
      expect(q.address).toContain('(демо)');
    }
    expect(Object.keys(SEED_REQUISITES).sort()).toEqual(['alfa', 'beta', 'delta', 'epsilon', 'gamma']);
  });

  it('повторный сид ничего не ломает: каталог и реквизиты те же', async () => {
    const before = await db.select().from(documentTemplates).orderBy(documentTemplates.key);
    await seedDatabase(db, { tz: TZ });
    const after = await db.select().from(documentTemplates).orderBy(documentTemplates.key);
    expect(after).toEqual(before);
  });
});

describe('заполнение: недостающие поля, суммы из calcTax', () => {
  it('без введённого вручную: реквизиты и расчёт подставлены, пропущены только поля пользователя', async () => {
    const id = await create('report_vat_certificate', { entityId: 'alfa', period: feb });
    const d = await getDocument(db, { userId, id, tz: TZ });
    // из обязательных не хватает «Подготовил»
    expect(d.missing).toEqual(['prepared_by']);
    expect(unfilledText(d.missing.length)).toBe('Не заполнено: 1 поле');
    expect(d.values.entity_name!.value).toBe('ООО «Альфа»');
    expect(d.values.entity_name!.source).toBe('entity');
    expect(d.values.entity_inn!.value).toBe(SEED_REQUISITES.alfa!.inn);
    expect(d.values.vat_total!.source).toBe('calc');
    // пропущенное поле остаётся в тексте файла в скобках
    const miss = (await blocksOf(id))
      .flatMap((b) => (b.kind === 'table' ? [] : b.segs))
      .filter((s) => s.t === 'field' && s.state === 'missing');
    expect(miss.map((s) => (s.t === 'field' ? s.key : ''))).toContain('prepared_by');
  });

  it('договор: пропущено много полей, счётчик по-русски', async () => {
    const id = await create('contract_rent_no_crew', { entityId: 'alfa' });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.missing).toEqual([
      'lessee_name',
      'lessee_details',
      'car_description',
      'rent_term',
      'rent_price',
      'contract_number',
      'contract_date',
    ].sort((a, b) => d.fields.findIndex((f) => f.key === a) - d.fields.findIndex((f) => f.key === b)));
    expect(unfilledText(7)).toBe('Не заполнено: 7 полей');
    expect(unfilledText(3)).toBe('Не заполнено: 3 поля');
    expect(unfilledText(1)).toBe('Не заполнено: 1 поле');
    expect(unfilledText(11)).toBe('Не заполнено: 11 полей');
    expect(unfilledText(0)).toBe('Все обязательные поля заполнены');
    // ставка НДС договора из расчёта
    expect(d.values.vat_rate!.source).toBe('calc');
    expect(d.values.city!.value).toBe('Петропавловск-Камчатский');
  });

  it('суммы документа равны calcTax до копейки, со ссылкой на шаг расчёта', async () => {
    const id = await makeCertificate();
    const d = await getDocument(db, { userId, id, tz: TZ });
    const r = calcTax({ entityIds: ['alfa'], tax: 'vat', period: feb }, await data());
    expect(d.values.vat_total!.value).toBe(r.total!.toString());
    expect(d.values.revenue!.value).toBe(r.revenue!.toString());
    expect(d.values.vat_rate!.value).toBe(String(r.entities[0]!.rate));
    expect(d.values.period_label!.value).toBe('февраль 2026');
    expect(d.values.vat_total!.calc?.step).toBe(r.totalStep);
    expect(d.sources.vat_total).toContain('Расчёт: НДС, февраль 2026');
    expect(d.missing).toEqual([]);
    // таблица по месяцам: одна строка, та же сумма
    const table = (await blocksOf(id)).find((b) => b.kind === 'table');
    expect(table && table.kind === 'table' && table.rows).toHaveLength(1);
  });

  it('суммы документа совпадают с ответом чата и сохранённым снимком', async () => {
    const id = await makeCertificate();
    const d = await getDocument(db, { userId, id, tz: TZ });
    const chat = await handleChat(db, { userId, question: 'НДС по Альфе за февраль', nowMs: NOW + 1000 });
    const res = await calcPost(post('/api/calc', { message: chat.agent.id }));
    const items = ((await res.json()) as { items: { total: string; revenue: string }[] }).items;
    expect(d.values.vat_total!.value).toBe(items[0]!.total);
    expect(d.values.revenue!.value).toBe(items[0]!.revenue);
    // «Показать расчёт» из документа открывает тот же снимок
    const own = await calcPost(post('/api/calc', { document: id }));
    expect(own.status).toBe(200);
    const snaps = ((await own.json()) as { items: { total: string }[] }).items;
    expect(snaps[0]!.total).toBe(d.values.vat_total!.value);
  });

  it('шаблон по группе и период для года', async () => {
    const id = await create('report_group_summary', { period: { kind: 'year', year: 2026 }, user: { prepared_by: 'Тест' } });
    const d = await getDocument(db, { userId, id, tz: TZ });
    const r = calcTax({ entityIds: 'all', tax: 'vat', period: { kind: 'year', year: 2026 } }, await data());
    expect(d.entityId).toBeNull();
    expect(d.values.group_vat!.value).toBe(r.total!.toString());
    const entities = (await blocksOf(id)).find((b) => b.kind === 'table' && b.table === 'entities');
    expect(entities && entities.kind === 'table' && entities.rows).toHaveLength(6); // пять юрлиц и итог
    expect(d.missing).toEqual([]);
  });

  it('УСН для юрлица на ОСНО: расчёта нет, поля помечены пропущенными', async () => {
    const id = await create('decl_usn_draft', {
      entityId: 'epsilon',
      period: { kind: 'year', year: 2026 },
      user: { ifns_code: '9900', oktmo: '00000000' },
    });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.values.usn_total!.value).toBeNull();
    expect(d.missing).toContain('usn_total');
  });

  it('введённое вручную проверяется по типу поля', () => {
    const money = TEMPLATES[0]!.fields.find((f) => f.key === 'rent_price')!;
    expect(normalizeInput(money, '5 000,5')).toBe('5000.50');
    expect(() => normalizeInput(money, 'много')).toThrow(FieldError);
    const date = TEMPLATES[0]!.fields.find((f) => f.key === 'contract_date')!;
    expect(normalizeInput(date, '2026-10-10')).toBe('2026-10-10');
    expect(() => normalizeInput(date, '10.10.2026')).toThrow(FieldError);
    expect(normalizeInput(money, '   ')).toBeNull();
  });

  it('запросы расчёта: налоги полей, период, юрлицо', () => {
    const t = TEMPLATES.find((x) => x.key === 'report_vat_certificate')!;
    expect(templateQueries(t, { entityId: 'alfa', period: feb })).toEqual([
      { tax: 'vat', period: feb, entityIds: ['alfa'] },
    ]);
    const contract = TEMPLATES[0]!;
    expect(templateQueries(contract, { entityId: 'alfa', period: null })).toEqual([
      { tax: 'vat', period: { kind: 'ytd' }, entityIds: ['alfa'] },
    ]);
    const values = fillFields(t.fields, { entity: null, snaps: [], user: {} });
    expect(missingKeys(t.fields, values).length).toBeGreaterThan(5);
  });
});

describe('версии, статусы, согласование', () => {
  it('правка создаёт новую версию, прежняя остаётся как была', async () => {
    const id = await create('report_vat_certificate', { entityId: 'alfa', period: feb });
    const v1 = await getDocument(db, { userId, id, tz: TZ });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('draft');

    const res = await saveVersion(db, { userId, id, baseVersion: 1, edits: { prepared_by: 'Образцов О.И.' }, nowMs: NOW + 5000, tz: TZ });
    expect(res.version).toBe(2);
    expect(res.status).toBe('draft');
    expect(res.changes.map((c) => c.field)).toEqual(['prepared_by']);

    const v2 = await getDocument(db, { userId, id, tz: TZ });
    expect(v2.version).toBe(2);
    expect(v2.values.prepared_by!.value).toBe('Образцов О.И.');
    expect(v2.versions.map((v) => v.n)).toEqual([2, 1]);
    expect(v2.versions[0]!.hash).not.toBe(v2.versions[1]!.hash);
    expect(v2.versions[0]!.hash).toMatch(/^[0-9a-f]{64}$/);

    // версия 1 цела
    const old = await getDocument(db, { userId, id, version: 1, tz: TZ });
    expect(old.values.prepared_by!.value).toBeNull();
    expect(old.hash).toBe(v1.hash);
    expect(old.readOnly).toBe(true);
    expect(old.can.edit).toBe(false);
  });

  it('версия неизменяема на уровне базы: обновление строки запрещено', async () => {
    const id = await makeCertificate();
    await expect(
      db.update(documentVersions).set({ authorName: 'Подмена' }).where(eq(documentVersions.documentId, id)),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update document_versions set body = 'x' where document_id = ${id}`),
    ).rejects.toThrow();
  });

  it('маршрут правки только создаёт версию: PUT, PATCH и DELETE версии нет', () => {
    const exported = Object.keys(versionsRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
    expect(exported).toEqual(['POST']);
  });

  it('без изменений версия не создаётся, устаревшая версия отклоняется', async () => {
    const id = await makeCertificate();
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: {}, nowMs: NOW, tz: TZ }),
    ).rejects.toMatchObject({ code: 'no_changes', status: 409 });
    await saveVersion(db, { userId, id, baseVersion: 1, edits: { purpose: 'Для сверки' }, nowMs: NOW, tz: TZ });
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: { purpose: 'Другое' }, nowMs: NOW, tz: TZ }),
    ).rejects.toMatchObject({ code: 'stale', status: 409 });
  });

  it('значения из расчёта вручную не меняются', async () => {
    const id = await makeCertificate();
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: { vat_total: '1' }, nowMs: NOW, tz: TZ }),
    ).rejects.toMatchObject({ code: 'field', status: 422 });
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: { entity_inn: '1' }, nowMs: NOW, tz: TZ }),
    ).rejects.toMatchObject({ code: 'field' });
  });

  it('отправка: нужны обязательные поля и получатель из бухгалтера и финдиректора', async () => {
    const id = await create('report_vat_certificate', { entityId: 'alfa', period: feb });
    await expect(
      submitDocument(db, { userId, id, recipientId: 'demo-accountant', comment: '', nowMs: NOW }),
    ).rejects.toMatchObject({ code: 'incomplete', data: { missing: ['prepared_by'] } });
    await saveVersion(db, { userId, id, baseVersion: 1, edits: { prepared_by: 'Тест' }, nowMs: NOW, tz: TZ });
    await expect(
      submitDocument(db, { userId, id, recipientId: 'demo-consultant', comment: '', nowMs: NOW }),
    ).rejects.toMatchObject({ code: 'recipient' });
    await submitDocument(db, { userId, id, recipientId: 'demo-cfo', comment: 'Проверьте, пожалуйста', nowMs: NOW });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.status).toBe('review');
    expect(STATUS_LABEL[d.status]).toBe('На проверке');
    expect(d.reviewer?.name).toBe('Сергей Примеров');
    expect(d.comments.some((c) => c.body === 'Проверьте, пожалуйста')).toBe(true);
    expect(d.events.map((e) => e.kind)).toContain('submitted');
  });

  it('на проверке править нельзя, нужно отозвать; после отзыва правка возвращает в «Черновик»', async () => {
    const id = await makeCertificate();
    await submitDocument(db, { userId, id, recipientId: 'demo-accountant', comment: '', nowMs: NOW });
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: { purpose: 'Правка' }, nowMs: NOW, tz: TZ }),
    ).rejects.toMatchObject({ code: 'edit_locked', status: 409 });
    await withdrawDocument(db, { userId, id, nowMs: NOW });
    expect((await getDocument(db, { userId, id, tz: TZ })).status).toBe('withdrawn');
    const res = await saveVersion(db, { userId, id, baseVersion: 1, edits: { purpose: 'После отзыва' }, nowMs: NOW, tz: TZ });
    expect(res.status).toBe('draft');
  });

  it('полный путь: проверка, замечание, правка, повторная отправка, согласование', async () => {
    const id = await makeCertificate();
    await submitDocument(db, { userId, id, recipientId: 'demo-accountant', comment: '', nowMs: NOW });

    await expect(simulateReply(db, { userId, id: await makeCertificate(), kind: 'approve', nowMs: NOW })).rejects.toMatchObject({
      code: 'bad_transition',
    });

    // замечание: статус «Есть замечания», комментарий помечен демо и привязан к полю
    expect(await simulateReply(db, { userId, id, kind: 'remark', nowMs: NOW + 1000 })).toBe('remarks');
    let d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.status).toBe('remarks');
    const remark = d.comments.find((c) => c.kind === 'remark')!;
    expect(remark.isDemo).toBe(true);
    expect(remark.authorName).toContain('(демо)');
    expect(remark.fieldKey).toBeTruthy();
    expect(d.can.simulate).toBe(false);

    // решить замечание, исправить, отправить заново
    await resolveComment(db, { userId, id, commentId: remark.id, resolved: true, nowMs: NOW + 2000 });
    const saved = await saveVersion(db, { userId, id, baseVersion: 1, edits: { purpose: 'Учёл замечание' }, nowMs: NOW + 3000, tz: TZ });
    expect(saved.status).toBe('draft');
    await submitDocument(db, { userId, id, recipientId: 'demo-accountant', comment: '', nowMs: NOW + 4000 });
    expect(await simulateReply(db, { userId, id, kind: 'comment', nowMs: NOW + 4500 })).toBe('review');
    expect(await simulateReply(db, { userId, id, kind: 'approve', nowMs: NOW + 5000 })).toBe('approved');

    d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.status).toBe('approved');
    expect(STATUS_LABEL[d.status]).toBe('Согласовано');
    expect(d.comments.find((c) => c.kind === 'approval')?.isDemo).toBe(true);
    const kinds = d.events.map((e) => e.kind);
    for (const k of ['created', 'version', 'submitted', 'remark', 'resolved', 'approval']) expect(kinds).toContain(k);
    const approvedHash = d.hash;
    const approvedVersion = d.version;

    // согласованная версия остаётся как была: правка даёт новую версию и «Черновик»
    const edit = await saveVersion(db, {
      userId,
      id,
      baseVersion: approvedVersion,
      edits: { purpose: 'Изменение после согласования' },
      nowMs: NOW + 6000,
      tz: TZ,
    });
    expect(edit.version).toBe(approvedVersion + 1);
    expect(edit.status).toBe('draft');
    const kept = await getDocument(db, { userId, id, version: approvedVersion, tz: TZ });
    expect(kept.hash).toBe(approvedHash);
    expect(kept.values.purpose!.value).toBe('Учёл замечание');
  });

  it('комментарии к полю: новый и решённый, лишнее поле отклоняется', async () => {
    const id = await makeCertificate();
    const c = await addComment(db, { userId, id, fieldKey: 'vat_total', body: 'Проверить сумму', nowMs: NOW });
    expect(c.fieldKey).toBe('vat_total');
    await expect(addComment(db, { userId, id, fieldKey: 'нет_такого', body: 'x', nowMs: NOW })).rejects.toBeInstanceOf(DocError);
    await expect(addComment(db, { userId, id, fieldKey: null, body: '   ', nowMs: NOW })).rejects.toBeInstanceOf(DocError);
    await resolveComment(db, { userId, id, commentId: c.id, resolved: true, nowMs: NOW });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.comments.find((x) => x.id === c.id)?.resolved).toBe(true);
    expect(await db.select().from(documentComments).where(eq(documentComments.documentId, id))).toHaveLength(1);
    expect((await db.select().from(documentEvents).where(eq(documentEvents.documentId, id))).length).toBeGreaterThanOrEqual(2);
  });

  it('обновление расчёта создаёт версию с пометкой в списке изменений', async () => {
    const id = await makeCertificate();
    // тот же момент и данные: нового нет, версия не создаётся
    await expect(
      saveVersion(db, { userId, id, baseVersion: 1, edits: {}, refreshCalc: true, nowMs: NOW, tz: TZ }),
    ).resolves.toMatchObject({ version: 2 });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.versions[0]!.changes[0]!.field).toBe('calc');
  });

  it('таблица переходов', () => {
    expect(transition('draft', 'submit')).toBe('review');
    expect(transition('approved', 'edit')).toBe('draft');
    expect(() => transition('review', 'edit')).toThrow(WorkflowError);
    expect(() => transition('draft', 'approve')).toThrow(WorkflowError);
    expect(actionsFor('review')).toEqual({ edit: false, submit: false, withdraw: true, simulate: true });
    expect(actionsFor('approved').edit).toBe(true);
    expect(Object.values(STATUS_LABEL)).toEqual(['Черновик', 'На проверке', 'Есть замечания', 'Согласовано', 'Отозвано']);
  });

  it('список документов: статус, версия, недостающие поля', async () => {
    const list = await listDocuments(db, userId);
    expect(list.length).toBeGreaterThan(5);
    const first = list[0]!;
    expect(first.title.length).toBeGreaterThan(5);
    expect(['draft', 'review', 'remarks', 'approved', 'withdrawn']).toContain(first.status);
    expect(await db.select().from(documents)).toHaveLength(list.length);
  });
});

describe('файлы: .docx и .xlsx', () => {
  async function wellFormed(xml: string) {
    const parser = new SaxesParser();
    let errors = 0;
    parser.on('error', () => (errors += 1));
    parser.write(xml).close();
    return errors === 0;
  }

  it('договор: корректный .docx с реквизитами, суммами и выделенными пропусками', async () => {
    const id = await create('contract_rent_no_crew', {
      entityId: 'alfa',
      user: { contract_number: '12', contract_date: '2026-10-10', rent_price: '7500' },
    });
    const out = await downloadDocument(db, { userId, id, tz: TZ });
    expect(out.name).toBe('Договор аренды автомобиля без экипажа, ООО «Альфа».docx');
    expect(out.mime).toBe(DOCX_MIME);
    expect(out.file.subarray(0, 2).toString()).toBe('PK');

    const zip = await JSZip.loadAsync(out.file);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml']));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(await wellFormed(xml)).toBe(true);
    // текст документа: прогоны одного абзаца склеены
    const text = plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
    expect(text).toContain('ООО «Альфа»');
    expect(text).toContain('Договор аренды автомобиля без экипажа № 12');
    expect(text).toContain('7 500,00');
    // ставка НДС из расчёта
    const rate = calcTax({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'ytd' } }, await data()).entities[0]!.rate;
    expect(text).toContain(`по ставке ${rate}%`);
    // пропущенное поле остаётся в документе в скобках и выделено
    expect(text).toContain('[Арендатор: наименование или ФИО]');
    expect(xml).toContain('w:highlight');
    const header = await zip.file(/^word\/header\d*\.xml$/)[0]!.async('string');
    expect(header).toContain('Образец, проверить юристом');
    // колонтитул мелким шрифтом: 8 пт это w:sz 16
    expect(header).toContain('<w:sz w:val="16"/>');
    // выделен именно пропущенный реквизит, а не весь абзац
    const highlighted = [...xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*?<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<w:t[^>]*>([^<]*)<\/w:t>/gs)].map(
      (m) => m[1],
    );
    expect(highlighted).toContain('[Арендатор: наименование или ФИО]');
    expect(highlighted.every((t) => t!.startsWith('[') && t!.endsWith(']'))).toBe(true);
    // заполненное не выделено
    expect(highlighted.join('')).not.toContain('Альфа');
  });

  it('подсветка пропуска держится и в абзаце с переносом строки', async () => {
    const blocks: RenderBlock[] = [
      {
        id: 'b0',
        kind: 'p',
        segs: [
          { t: 'text', text: 'Реквизиты: ' },
          { t: 'field', key: 'a', label: 'Первая', state: 'filled', source: 'user', type: 'longtext', text: 'строка 1\nстрока 2', value: 'x', calcIndex: null },
          { t: 'text', text: ', подписант ' },
          { t: 'field', key: 'b', label: 'Подписант', state: 'missing', source: 'user', type: 'text', text: '[Подписант]', value: null, calcIndex: null },
        ],
      },
    ];
    const file = await buildDocx(blocks, { title: 'Тест', version: 1, hash: 'a'.repeat(64), at: NOW, tz: TZ });
    const xml = await (await JSZip.loadAsync(file)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:br/>');
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<w:t[^>]*>\[Подписант\]<\/w:t>/s);
    expect(xml.match(/<w:highlight /g)).toHaveLength(1);
  });

  it('отчёт: таблица по месяцам в .docx, суммы как на экране', async () => {
    const id = await create('report_vat_certificate', {
      entityId: 'alfa',
      period: { kind: 'quarter', year: 2026, quarter: 1 },
      user: { prepared_by: 'Тест' },
    });
    const d = await getDocument(db, { userId, id, tz: TZ });
    const out = await downloadDocument(db, { userId, id, tz: TZ });
    const xml = await (await JSZip.loadAsync(out.file)).file('word/document.xml')!.async('string');
    expect(await wellFormed(xml)).toBe(true);
    const text = plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
    expect(text).toContain(plain(d.values.vat_total!.display!));
    expect(text).toContain(plain(d.values.revenue!.display!));
    expect(text).toContain('январь 2026');
    expect(text).toContain('март 2026');
    expect(xml).toContain('<w:tbl>');
  });

  it('декларация: .xlsx с водяным знаком, суммы числами, листы расчёта с формулами', async () => {
    const id = await create('decl_vat_draft', {
      entityId: 'alfa',
      period: { kind: 'year', year: 2026 },
      user: { ifns_code: '9900' },
    });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.output).toBe('xlsx');
    expect(d.fileName).toBe(`${d.title}.xlsx`);
    const out = await downloadDocument(db, { userId, id, tz: TZ });
    expect(out.name).toBe(d.fileName);
    expect(out.mime).toBe(XLSX_MIME);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.file as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Проект декларации', 'Итог', 'По месяцам', 'Расчёт', 'Источник']);
    const ws = wb.getWorksheet('Проект декларации')!;
    expect(String(ws.getCell('A1').value)).toBe('Проект. Не для подачи');
    let found: number | null = null;
    ws.eachRow((row) => {
      if (String(row.getCell(1).value).startsWith('НДС по расчёту')) found = row.getCell(2).value as number;
    });
    expect(found).toBe(Number(d.values.vat_total!.value));
    let formulas = 0;
    wb.getWorksheet('Расчёт')!.eachRow((row) =>
      row.eachCell((c) => {
        const v = c.value as { formula?: string } | null;
        if (v && typeof v === 'object' && v.formula) formulas += 1;
      }),
    );
    expect(formulas).toBeGreaterThan(20);
    // файл расчёта документа: те же снимки
    const calcFile = await downloadGet(new NextRequest(`http://localhost/api/documents/${id}/download?calc=1`), ctx(id));
    expect(calcFile.status).toBe(200);
  });
});

describe('лист на экране: блоки и сетка деклараций', () => {
  it('деклараций: титульные строки это пары «название и значение», таблица расчёта сохраняется', async () => {
    const id = await create('decl_vat_draft', { entityId: 'alfa', period: { kind: 'year', year: 2026 } });
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(d.blocks.length).toBeGreaterThan(8);
    const rows = gridRows(d.blocks);
    expect(rows[0]).toMatchObject({ kind: 'title' });
    const pairs = rows.filter((r) => r.kind === 'pair');
    const labels = pairs.map((r) => (r.kind === 'pair' ? r.label : ''));
    expect(labels).toEqual(expect.arrayContaining(['Налогоплательщик', 'ИНН', 'Код налогового органа', 'НДС по расчёту']));
    // значение пары это поля: сумма из расчёта и пропущенный код налогового органа
    const vat = pairs.find((r) => r.kind === 'pair' && r.label === 'НДС по расчёту');
    expect(vat && vat.kind === 'pair' && vat.segs.some((s) => s.t === 'field' && s.key === 'vat_total' && s.state === 'filled')).toBe(true);
    const code = pairs.find((r) => r.kind === 'pair' && r.label === 'Код налогового органа');
    expect(code && code.kind === 'pair' && code.segs.some((s) => s.t === 'field' && s.state === 'missing')).toBe(true);
    expect(rows.some((r) => r.kind === 'table' && r.table === 'months')).toBe(true);
    expect(rows.some((r) => r.kind === 'section')).toBe(true);
  });

  it('текст договора: у каждого поля состояние и источник, суммы строкой из расчёта', async () => {
    const id = await makeCertificate();
    const d = await getDocument(db, { userId, id, tz: TZ });
    const fields = d.blocks.flatMap((b) => (b.kind === 'table' ? [] : b.segs)).filter((s) => s.t === 'field');
    const total = fields.find((s) => s.t === 'field' && s.key === 'vat_total');
    expect(total).toMatchObject({ state: 'filled', source: 'calc', value: d.values.vat_total!.value });
    expect(total && total.t === 'field' && total.text).toBe(d.values.vat_total!.display);
    expect(d.sources.vat_total).toContain('Расчёт');
  });
});

describe('«Открыть»: маршрут /api/documents/[id]/file', () => {
  const get = (id: string, qs = '') => fileGet(new NextRequest(`http://localhost/api/documents/${id}/file${qs}`), ctx(id));
  const nameOf = (cd: string) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)![1]!);
  const docText = async (buf: Buffer) => {
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    return plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
  };

  it('договор: .docx с верным типом и именем, по умолчанию сохраняется', async () => {
    const id = await create('contract_rent_no_crew', { entityId: 'beta' });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(DOCX_MIME);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment; filename="document\.docx"; filename\*=UTF-8''/);
    expect(nameOf(cd)).toBe('Договор аренды автомобиля без экипажа, ИП Бета.docx');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(Number(res.headers.get('content-length'))).toBe(body.length);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // имя в заголовке и имя на карточке файла это одна строка
    const d = await getDocument(db, { userId, id, tz: TZ });
    expect(nameOf(cd)).toBe(d.fileName);
    // в файле видны незаполненные поля в виде [поле]
    expect(await docText(body)).toContain('[Номер договора]');
  });

  it('inline=1: встроенный просмотр на iPhone и iPad', async () => {
    const id = await create('report_vat_certificate', { entityId: 'alfa', period: feb });
    const res = await get(id, '?inline=1');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; /);
    expect(res.headers.get('content-type')).toBe(DOCX_MIME);
  });

  it('декларация: .xlsx с типом Excel', async () => {
    const id = await create('decl_vat_draft', { entityId: 'alfa', period: { kind: 'year', year: 2026 } });
    const res = await get(id);
    expect(res.headers.get('content-type')).toBe(XLSX_MIME);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toContain('filename="document.xlsx"');
    expect(nameOf(cd)).toMatch(/^Проект декларации по НДС, ООО «Альфа», .+\.xlsx$/);
    // незаполненное поле жёлтое: ячейка с [подписью] залита FFFF00
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await res.arrayBuffer()) as ArrayBuffer);
    const ws = wb.getWorksheet('Проект декларации')!;
    let yellow = 0;
    ws.eachRow((row) => {
      const c = row.getCell(1);
      const fill = c.fill as { fgColor?: { argb?: string } } | undefined;
      if (/\[[^\]]+\]/.test(String(c.value)) && fill?.fgColor?.argb === 'FFFFFF00') yellow += 1;
    });
    expect(yellow).toBeGreaterThan(0);
  });

  it('без версии это актуальная версия, с ?version=N версия из истории', async () => {
    const id = await create('contract_rent_no_crew', { entityId: 'alfa' });
    await saveVersion(db, { userId, id, baseVersion: 1, edits: { contract_number: '77' }, nowMs: NOW, tz: TZ });
    const current = await get(id);
    expect(nameOf(current.headers.get('content-disposition')!)).toBe('Договор аренды автомобиля без экипажа, ООО «Альфа».docx');
    const currentText = await docText(Buffer.from(await current.arrayBuffer()));
    expect(currentText).toContain('№ 77');

    const old = await get(id, '?version=1');
    expect(nameOf(old.headers.get('content-disposition')!)).toBe(
      'Договор аренды автомобиля без экипажа, ООО «Альфа» (версия 1).docx',
    );
    const oldText = await docText(Buffer.from(await old.arrayBuffer()));
    expect(oldText).toContain('№ [Номер договора]');
  });

  it('чужого или несуществующего документа нет: 404', async () => {
    const missing = await get('00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    const id = await create('report_group_summary', { period: { kind: 'year', year: 2026 } });
    expect((await get(id, '?version=9')).status).toBe(404);
  });

  it('имя файла: без недопустимых знаков, с версией и ASCII-запасным именем', () => {
    expect(documentFileName('Договор: аренда/субаренда?', 'docx')).toBe('Договор аренда субаренда.docx');
    expect(documentFileName('  ', 'xlsx')).toBe('Документ.xlsx');
    expect(documentFileName('Справка, ООО «Альфа»', 'docx', 3)).toBe('Справка, ООО «Альфа» (версия 3).docx');
    expect(documentFileName('а'.repeat(300), 'docx').length).toBeLessThanOrEqual(155);
    const cd = contentDisposition('Справка, ООО «Альфа».docx', 'inline');
    expect(cd.startsWith('inline; filename="document.docx"; filename*=UTF-8\'\'')).toBe(true);
    expect(cd).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('предложения формулировок: слова, без сумм и дат', () => {
  it('варианты с цифрами, месяцами и валютой отбрасываются', () => {
    const list = sanitizeSuggestions(
      ['Оплата 5000 рублей', 'Платёж в октябре', 'Стоимость в ₽', 'Автомобиль возвращается с полным баком.'],
      'special_terms',
    );
    expect(list).toEqual(['Автомобиль возвращается с полным баком.']);
    // всё отброшено: готовые варианты, и в них цифр нет
    const fallback = sanitizeSuggestions(['5000', 'в январе'], 'special_terms');
    expect(fallback.length).toBeGreaterThan(0);
    for (const t of fallback) {
      expect(t).not.toMatch(/\d/);
      expect(MONTH_WORDS.test(t)).toBe(false);
    }
  });

  it('маршрут: только поля, где предложение разрешено; ответ без цифр', async () => {
    const id = await create('contract_rent_no_crew', { entityId: 'alfa' });
    const ok = await suggestPost(post(`/api/documents/${id}/suggest`, { fieldKey: 'special_terms' }), ctx(id));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { suggestions: string[] };
    expect(body.suggestions.length).toBeGreaterThan(0);
    for (const s of body.suggestions) expect(s).not.toMatch(/\d/);
    await expect(suggestPost(post(`/api/documents/${id}/suggest`, { fieldKey: 'rent_price' }), ctx(id))).resolves.toMatchObject({
      status: 422,
    });
  });
});

describe('маршруты документов', () => {
  it('создание, чтение, список, отправка и имитация ответа через API', async () => {
    const created = await createPost(
      post('/api/documents', {
        templateKey: 'report_vat_certificate',
        entityId: 'beta',
        period: { kind: 'month', year: 2026, month: 3 },
        values: { prepared_by: 'Тест API' },
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const got = await docGet(new NextRequest(`http://localhost/api/documents/${id}`), ctx(id));
    const detail = (await got.json()) as { status: string; entityName: string; missing: string[]; can: { submit: boolean } };
    expect(detail.status).toBe('draft');
    expect(detail.entityName).toBe('ИП Бета');
    expect(detail.missing).toEqual([]);
    expect(detail.can.submit).toBe(true);

    const sent = await submitPost(post(`/api/documents/${id}/submit`, { recipientId: 'demo-accountant', comment: '' }), ctx(id));
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { demo: boolean }).demo).toBe(true);
    const ans = await simulatePost(post(`/api/documents/${id}/simulate`, { kind: 'approve' }), ctx(id));
    expect(((await ans.json()) as { status: string }).status).toBe('approved');

    const list = await listGet(new NextRequest('http://localhost/api/documents'));
    const items = ((await list.json()) as { documents: { id: string; status: string }[] }).documents;
    expect(items.find((x) => x.id === id)?.status).toBe('approved');

    const bad = await createPost(post('/api/documents', { templateKey: 'нет_такого', entityId: 'alfa' }));
    expect(bad.status).toBe(404);
    const noPeriod = await createPost(post('/api/documents', { templateKey: 'report_vat_certificate', entityId: 'alfa' }));
    expect(noPeriod.status).toBe(422);
    const notMine = await docGet(new NextRequest('http://localhost/api/documents/00000000-0000-0000-0000-000000000000'), ctx('00000000-0000-0000-0000-000000000000'));
    expect(notMine.status).toBe(404);
  });
});

describe('миграция 0004 только добавляет', () => {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const statements = (file: string) =>
    fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

  it('в файле нет ничего, что удаляет или переписывает данные', () => {
    const list = statements('0004_documents.sql');
    for (const st of list) {
      expect(st, st).toMatch(
        /^(CREATE TABLE|CREATE INDEX|CREATE FUNCTION|CREATE TRIGGER|ALTER TABLE "[a-z_]+" ADD (COLUMN|CONSTRAINT))/,
      );
      const body = st
        .replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null)/gi, '')
        .replace(/BEFORE UPDATE ON/g, 'BEFORE ON');
      if (!/^CREATE FUNCTION/.test(st)) expect(body, st).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b|ALTER COLUMN/i);
    }
  });

  it('данные до миграции сохраняются, реквизиты юрлица пустые', async () => {
    const old = new PGlite();
    try {
      const files = fs.readdirSync(dir).filter((f) => /^000[0-3]_.*\.sql$/.test(f)).sort();
      for (const f of files) for (const st of statements(f)) await old.exec(st);
      await old.exec(`insert into legal_entities (id, name, form, owner_label, vat_status, annual_revenue, input_vat_share, color)
                      values ('alfa', 'ООО «Альфа»', 'ООО', 'Собственник 1', 'payer', 28400000, 0.82, '#000000')`);
      for (const st of statements('0004_documents.sql')) await old.exec(st);
      const rows = await old.query<{ name: string; requisites: unknown }>('select name, requisites from legal_entities');
      expect(rows.rows).toEqual([{ name: 'ООО «Альфа»', requisites: null }]);
      for (const t of ['document_templates', 'documents', 'document_versions', 'document_comments', 'document_events']) {
        expect((await old.query(`select count(*)::int as n from ${t}`)).rows).toEqual([{ n: 0 }]);
      }
      await expect(old.exec(`insert into documents (template_key, title, created_by, status)
                              values ('x', 't', gen_random_uuid(), 'bogus')`)).rejects.toThrow();
    } finally {
      await old.close();
    }
  });
});

void renderBlocks;
