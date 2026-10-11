import { z } from 'zod';
import { calcTax, type CalcData } from '@/lib/calc/service';
import type { CalcQuery } from './query';
import { toSnapshot, type CalcSnapshot } from './snapshot';

/** Разбор тела запроса и выполнение запросов. Только сервер: клиент zod не загружает. */

export const PeriodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('month'), year: z.number().int(), month: z.number().int() }),
  z.object({ kind: z.literal('quarter'), year: z.number().int(), quarter: z.number().int() }),
  z.object({ kind: z.literal('year'), year: z.number().int() }),
  z.object({ kind: z.literal('ytd') }),
  z.object({ kind: z.literal('range'), from: z.string().max(10), to: z.string().max(10) }),
]);

export const CalcQuerySchema = z.object({
  tax: z.enum(['vat', 'usn', 'profit']),
  period: PeriodSchema,
  entityIds: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).min(1).max(20)]),
  rate: z.union([z.literal(5), z.literal(7), z.literal(22)]).optional(),
});

/** Запросы расчёта и момент, на который считать: по ним панель, Excel и запрос на проверку. */
export const QueriesTargetSchema = z.object({
  queries: z.array(CalcQuerySchema).min(1).max(6),
  /** Момент расчёта, мс UTC: «сегодня» для расчёта. Без него сервер берёт текущий */
  at: z.number().int().positive().optional(),
});

/** Расчёт из сохранённого ответа чата: все снимки ответа. */
export const MessageTargetSchema = z.object({
  message: z.number().int().positive(),
});

/** Расчёт, сохранённый в версии документа: панель и проверка показывают те же снимки, что в документе. */
export const DocumentTargetSchema = z.object({
  document: z.string().uuid(),
  version: z.number().int().positive().optional(),
});

export const TargetSchema = z.union([QueriesTargetSchema, MessageTargetSchema, DocumentTargetSchema]);
export type CalcTarget = z.infer<typeof TargetSchema>;

/** «Сегодня» берётся из запроса, но не дальше суток от серверного времени. */
export const AT_WINDOW_MS = 24 * 3_600_000;

export function clampAt(at: number | undefined, nowMs: number): number {
  if (at === undefined) return nowMs;
  return Math.abs(at - nowMs) <= AT_WINDOW_MS ? at : nowMs;
}

/** Считает запросы по одному снимку данных. Ошибки расчёта (CalcInputError, PeriodError) уходят наверх. */
export function runQueries(
  data: CalcData,
  queries: CalcQuery[],
  meta: { at: number; tz: string },
): CalcSnapshot[] {
  return queries.map((q) =>
    toSnapshot(
      calcTax({ entityIds: q.entityIds, tax: q.tax, period: q.period, rate: q.rate }, data),
      { at: meta.at, tz: meta.tz, scope: q.entityIds },
    ),
  );
}

