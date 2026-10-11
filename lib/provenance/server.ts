import { and, desc, eq } from 'drizzle-orm';
import { CalcInputError } from '@/lib/calc/service';
import { PeriodError } from '@/lib/calc/period';
import { momentFromEpoch } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { chatMessages, checks, people, reviewRequests } from '@/lib/db/schema';
import { documentSnapshots, DocError } from '@/lib/documents/service';
import { buildWorkbook } from '@/lib/export/xlsx';
import { exportFileName, requestTitle } from './query';
import { clampAt, runQueries, type CalcTarget } from './schemas';
import { fromSnapshot, type CalcSnapshot } from './snapshot';
import { REVIEW_STATUS_LABEL, type CheckMark, type ReviewItem } from './types';

/**
 * Серверные операции над расчётом: найти снимки по цели (запросы или сохранённый ответ чата),
 * собрать Excel, записать запрос на проверку и отметки «сверил». Маршруты API только разбирают
 * тело запроса и зовут эти функции, поэтому их можно проверять на настоящей базе без HTTP.
 */

export class TargetError extends Error {
  constructor(
    message: string,
    public status: 404 | 422,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Снимки расчёта по цели. Запросы считаются сейчас на момент `at`, ответ чата читается из базы. */
export async function resolveTarget(
  db: Db,
  args: { userId: string; target: CalcTarget; nowMs: number; tz: string },
): Promise<CalcSnapshot[]> {
  const { target } = args;
  if ('document' in target) {
    try {
      return await documentSnapshots(db, { userId: args.userId, id: target.document, version: target.version });
    } catch (e) {
      if (e instanceof DocError) throw new TargetError(e.message, e.status === 404 ? 404 : 422);
      throw e;
    }
  }
  if ('message' in target) {
    const [row] = await db
      .select({ calc: chatMessages.calc })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, target.message),
          eq(chatMessages.userId, args.userId),
          eq(chatMessages.role, 'agent'),
        ),
      )
      .limit(1);
    const stored = (row?.calc as { results?: CalcSnapshot[] } | null)?.results;
    if (!row || !stored || stored.length === 0) {
      throw new TargetError('У этого ответа нет расчёта', 404);
    }
    return stored;
  }

  const at = clampAt(target.at, args.nowMs);
  try {
    const data = await loadCalcData(db, momentFromEpoch(at, args.tz));
    return runQueries(data, target.queries, { at, tz: args.tz });
  } catch (e) {
    if (e instanceof CalcInputError || e instanceof PeriodError) throw new TargetError(e.message, 422);
    throw e;
  }
}

export async function excelFor(snaps: CalcSnapshot[]): Promise<{ name: string; file: Buffer }> {
  const first = snaps[0]!;
  const file = await buildWorkbook(snaps.map(fromSnapshot), { at: first.at, tz: first.tz });
  return { name: exportFileName(snaps), file };
}

// ===== Запросы на проверку =====

export async function listPeople(db: Db) {
  const rows = await db.select().from(people).orderBy(people.sort, people.id);
  return rows.map((p) => ({ id: p.id, name: p.name, role: p.role }));
}

function toItem(
  r: typeof reviewRequests.$inferSelect,
  p: { id: string; name: string; role: string },
): ReviewItem {
  const snaps = r.snapshot as CalcSnapshot[];
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    statusLabel: REVIEW_STATUS_LABEL[r.status] ?? r.status,
    comment: r.comment,
    recipient: p,
    totals: snaps.map((s) => ({ label: `${s.taxName}, ${s.periodLabel}`, total: s.total })),
    excelName: r.excelName,
    createdAt: r.createdAt.toISOString(),
    demo: true,
  };
}

export async function listReviews(db: Db, userId: string): Promise<ReviewItem[]> {
  const rows = await db
    .select({ r: reviewRequests, p: people })
    .from(reviewRequests)
    .innerJoin(people, eq(people.id, reviewRequests.recipientId))
    .where(eq(reviewRequests.createdBy, userId))
    .orderBy(desc(reviewRequests.createdAt), desc(reviewRequests.id))
    .limit(100);
  return rows.map(({ r, p }) => toItem(r, { id: p.id, name: p.name, role: p.role }));
}

/**
 * Создаёт запрос: снимок расчёта и Excel сохраняются вместе с запросом. Письмо не отправляется,
 * это демо: запись в базе и есть весь «отправленный» результат.
 */
export async function createReview(
  db: Db,
  args: { userId: string; recipientId: string; comment: string; snaps: CalcSnapshot[] },
): Promise<ReviewItem> {
  const [person] = await db.select().from(people).where(eq(people.id, args.recipientId)).limit(1);
  if (!person) throw new TargetError('Получатель не найден в справочнике', 404);
  if (args.snaps.length === 0) throw new TargetError('Нет расчёта для передачи', 422);

  const { name, file } = await excelFor(args.snaps);
  const [row] = await db
    .insert(reviewRequests)
    .values({
      type: 'calc',
      createdBy: args.userId,
      recipientId: person.id,
      comment: args.comment,
      status: 'sent',
      title: requestTitle(args.snaps),
      snapshot: args.snaps,
      excelName: name,
      excelFile: file,
    })
    .returning();
  return toItem(row!, { id: person.id, name: person.name, role: person.role });
}

export async function reviewExcel(
  db: Db,
  args: { userId: string; id: string },
): Promise<{ name: string; file: Buffer } | null> {
  const [row] = await db
    .select({ name: reviewRequests.excelName, file: reviewRequests.excelFile })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.id, args.id), eq(reviewRequests.createdBy, args.userId)))
    .limit(1);
  return row ? { name: row.name, file: row.file } : null;
}

// ===== Отметки «сверил» =====

export async function listChecks(db: Db, args: { userId: string; subject: string }): Promise<CheckMark[]> {
  const rows = await db
    .select()
    .from(checks)
    .where(and(eq(checks.userId, args.userId), eq(checks.subject, args.subject)));
  return rows.map((r) => ({ item: r.item, amount: r.amount, checkedAt: r.checkedAt.toISOString() }));
}

/** Ставит или снимает отметку. Повторная отметка обновляет сумму и время. */
export async function setCheck(
  db: Db,
  args: { userId: string; subject: string; item: string; checked: boolean; amount: string | null },
): Promise<CheckMark | null> {
  if (!args.checked) {
    await db
      .delete(checks)
      .where(and(eq(checks.userId, args.userId), eq(checks.subject, args.subject), eq(checks.item, args.item)));
    return null;
  }
  const [row] = await db
    .insert(checks)
    .values({ userId: args.userId, subject: args.subject, item: args.item, amount: args.amount })
    .onConflictDoUpdate({
      target: [checks.userId, checks.subject, checks.item],
      set: { amount: args.amount, checkedAt: new Date() },
    })
    .returning();
  return { item: row!.item, amount: row!.amount, checkedAt: row!.checkedAt.toISOString() };
}

