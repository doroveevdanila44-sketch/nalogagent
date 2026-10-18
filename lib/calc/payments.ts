import { monthAmount, selectedRate, taxFor } from './calc';
import { dec, ZERO, sum, type Dec } from './decimal';
import { incomeTaxSchedule, type PaymentPeriod } from './income-tax';
import { compareDays, type CalendarDay, type Moment } from './time';
import type { CalcCtx, EntityInput, Selections } from './types';

/** Выручка юрлица за квартал `quarter` (0..3): факт прошедших месяцев или прогноз. */
export function quarterRevenue(e: EntityInput, ctx: CalcCtx, quarter: number, now: Moment): Dec {
  return sum([0, 1, 2].map((k) => monthAmount(e, ctx, quarter * 3 + k, now)));
}

export interface GroupPayment {
  due: CalendarDay;
  kind: 'usn' | 'profit' | 'vat';
  entityId: string;
  entityName: string;
  amount: Dec;
  /** Для налога по доходам: период и признак итоговой уплаты */
  period?: PaymentPeriod;
  periodLabel?: string;
  final?: boolean;
  /** Для НДС: номер трети 1..3 и квартал 1..4, за который платится */
  vatThird?: number;
  vatQuarter?: number;
}

/**
 * Предстоящие платежи группы с сегодняшнего дня, по возрастанию срока:
 *  - УСН и налог на прибыль: авансы и итог года по графику юрлица;
 *  - НДС за прошедший квартал тремя равными частями до 28 числа трёх месяцев после квартала; в четвёртом
 *    квартале добавляются три доли за четвёртый квартал со сроками в январе, феврале и марте следующего года.
 * Для первого квартала данных о прошлом годе нет, платежи НДС не строятся.
 */
export function groupPayments(
  entities: EntityInput[],
  selections: Selections,
  ctx: CalcCtx,
  now: Moment,
): GroupPayment[] {
  const today: CalendarDay = { year: now.year, month: now.month, day: now.day };
  const out: GroupPayment[] = [];

  for (const e of entities) {
    for (const p of incomeTaxSchedule(e, ctx, selections, now)) {
      if (compareDays(p.due, today) < 0) continue;
      out.push({
        due: p.due,
        kind: e.taxRegime === 'osno' ? 'profit' : 'usn',
        entityId: e.id,
        entityName: e.name,
        amount: p.amount,
        period: p.period,
        periodLabel: p.periodLabel,
        final: p.kind === 'final',
      });
    }
  }

  const q = Math.floor(now.month / 3);
  if (q > 0) {
    const prev = q - 1;
    for (const e of entities) {
      if (e.status !== 'payer') continue;
      const total = taxFor(
        selectedRate(e, selections),
        quarterRevenue(e, ctx, prev, now),
        e.inputVatShare,
        ctx.rules.generalRate,
      );
      const third = total.div(3);
      for (let k = 0; k < 3; k++) {
        const due: CalendarDay = { year: now.year, month: (prev + 1) * 3 + k, day: ctx.rules.paymentDay };
        if (compareDays(due, today) < 0) continue;
        out.push({
          due,
          kind: 'vat',
          entityId: e.id,
          entityName: e.name,
          amount: third,
          vatThird: k + 1,
          vatQuarter: prev + 1,
        });
      }
    }
  }

  // В четвёртом квартале идут и платежи за третий, и платежи за четвёртый: они выпадают на январь,
  // февраль и март следующего года. Без них после 28 декабря ближайшим стал бы платёж в конце марта.
  if (q === 3) {
    for (const e of entities) {
      if (e.status !== 'payer') continue;
      const third = taxFor(
        selectedRate(e, selections),
        quarterRevenue(e, ctx, 3, now),
        e.inputVatShare,
        ctx.rules.generalRate,
      ).div(3);
      for (let k = 0; k < 3; k++) {
        out.push({
          due: { year: now.year + 1, month: k, day: ctx.rules.paymentDay },
          kind: 'vat',
          entityId: e.id,
          entityName: e.name,
          amount: third,
          vatThird: k + 1,
          vatQuarter: 4,
        });
      }
    }
  }

  const order = { usn: 0, profit: 1, vat: 2 } as const;
  return out.sort((a, b) => compareDays(a.due, b.due) || order[a.kind] - order[b.kind]);
}

/** Сумма платежей одного вида на дату. */
export function sumKind(payments: GroupPayment[], kind: GroupPayment['kind'], due: CalendarDay): Dec {
  return payments
    .filter((p) => p.kind === kind && compareDays(p.due, due) === 0)
    .reduce((acc, p) => acc.plus(p.amount), ZERO);
}

/** Целых дней от сегодняшней даты до срока (в календарных датах, без времени суток). */
export function daysUntil(due: CalendarDay, now: Moment): number {
  const a = Date.UTC(now.year, now.month, now.day);
  const b = Date.UTC(due.year, due.month, due.day);
  return Math.round((b - a) / 86_400_000);
}
