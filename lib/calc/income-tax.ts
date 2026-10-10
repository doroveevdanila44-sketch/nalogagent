import { baseRev, monthAmount, selectedRate, ytd } from './calc';
import { D, ZERO, dec, sum, type Dec } from './decimal';
import { compareDays, type CalendarDay, type Moment } from './time';
import type { CalcCtx, EntityInput, Selections, TaxRegime } from './types';

/**
 * Налог на прибыль (ОСНО) и налог по УСН. Деньги только на Decimal.
 * Ставки и день платежа берутся из справочника rules (RuleSet), а не из кода.
 * Суммы ориентировочные: страховые взносы, региональные ставки и перенос сроков
 * не учитываются. Все цифры проверять с бухгалтером.
 */

export const REGIME_LABEL: Record<TaxRegime, string> = {
  usn_income: 'УСН доходы',
  usn_income_expense: 'УСН доходы минус расходы',
  osno: 'ОСНО',
};

/** Название налога для блока юрлица */
export const TAX_NAME: Record<TaxRegime, string> = {
  usn_income: 'Налог по УСН',
  usn_income_expense: 'Налог по УСН',
  osno: 'Налог на прибыль',
};

export type PaymentPeriod = 'q1' | 'h1' | '9m' | 'year';

export const PERIOD_LABEL: Record<PaymentPeriod, string> = {
  q1: 'за 3 месяца',
  h1: 'за полугодие',
  '9m': 'за 9 месяцев',
  year: 'за год',
};

/** Конец отчётного периода: индекс месяца, включительно, и месяц срока авансового платежа */
const ADVANCES: { period: Exclude<PaymentPeriod, 'year'>; through: number; dueMonth: number }[] = [
  { period: 'q1', through: 2, dueMonth: 3 },
  { period: 'h1', through: 5, dueMonth: 6 },
  { period: '9m', through: 8, dueMonth: 9 },
];

export interface PaymentPoint {
  due: CalendarDay;
  period: PaymentPeriod;
  periodLabel: string;
  /** advance: авансовый платёж, final: итоговая уплата за год */
  kind: 'advance' | 'final';
  amount: Dec;
}

/** Сумма выручки за год с учётом фактов прошедших месяцев (знаменатель долей накопления). */
export function yearTotal(e: EntityInput, ctx: CalcCtx, now: Moment): Dec {
  let acc = ZERO;
  for (let m = 0; m < 12; m++) acc = acc.plus(monthAmount(e, ctx, m, now));
  return acc;
}

/** Доля годовой выручки, накопленная к концу месяца `throughMonth` (0..11) включительно. */
export function cumulativeShare(e: EntityInput, ctx: CalcCtx, throughMonth: number, now: Moment): Dec {
  const total = yearTotal(e, ctx, now);
  if (total.isZero()) return ZERO;
  let acc = ZERO;
  for (let m = 0; m <= throughMonth; m++) acc = acc.plus(monthAmount(e, ctx, m, now));
  return acc.div(total);
}

/**
 * Выручка за год без НДС: годовая выручка минус НДС, заложенный в ту её часть, что облагается.
 * Плательщик: выручка × 100 / (100 + ставка). Освобождённый: выручка как есть
 * (после пересечения порога облагаемая часть уменьшается на свой НДС).
 * Ставка НДС берётся выбранная; на ОСНО это общая 22%.
 */
export function incomeExVat(e: EntityInput, ctx: CalcCtx, selections: Selections, now: Moment): Dec {
  const r = selectedRate(e, selections);
  const embedded = baseRev(e, ctx, now).times(r).div(100 + r);
  return e.annualRevenue.minus(embedded);
}

/** Ставка налога долей: у юрлица (если задана), иначе из справочника по режиму. */
export function incomeTaxRate(e: EntityInput, ctx: CalcCtx): Dec {
  if (e.taxRegime === 'osno') return ctx.rules.profitTaxRate;
  if (e.usnRate) return e.usnRate;
  return e.taxRegime === 'usn_income_expense' ? ctx.rules.usnRateIncomeExpense : ctx.rules.usnRateIncome;
}

export interface IncomeTaxResult {
  regime: TaxRegime;
  label: string;
  taxName: string;
  /** Ставка в процентах: 6, 15, 25 */
  ratePct: Dec;
  /** Выручка без НДС */
  income: Dec;
  expenses: Dec;
  /** Налоговая база: доходы, доходы минус расходы или прибыль, не меньше нуля */
  base: Dec;
  /** Налог по ставке до применения минимального налога */
  calculated: Dec;
  /** Минимальный налог УСН: 1% доходов. Для остальных режимов ноль */
  minimum: Dec;
  /** Налог за год */
  forecast: Dec;
  minTaxApplied: boolean;
  /** Начислено на момент `now` по накоплению выручки */
  accrued: Dec;
}

export function incomeTax(e: EntityInput, ctx: CalcCtx, selections: Selections, now: Moment): IncomeTaxResult {
  const income = incomeExVat(e, ctx, selections, now);
  const rate = incomeTaxRate(e, ctx);
  const expenses = e.taxRegime === 'usn_income' ? ZERO : e.annualExpenses;

  let base: Dec;
  let calculated: Dec;
  let minimum = ZERO;
  switch (e.taxRegime) {
    case 'usn_income':
      base = income;
      calculated = base.times(rate);
      break;
    case 'usn_income_expense':
      base = D.max(ZERO, income.minus(expenses));
      calculated = base.times(rate);
      minimum = income.times(ctx.rules.usnMinTaxRate);
      break;
    case 'osno':
      // прибыль = выручка без НДС минус расходы; убыток налога не даёт
      base = D.max(ZERO, income.minus(expenses));
      calculated = base.times(rate);
      break;
  }
  const forecast = D.max(calculated, minimum);

  const total = yearTotal(e, ctx, now);
  const share = total.isZero() ? ZERO : D.min(dec(1), ytd(e, ctx, now).div(total));

  return {
    regime: e.taxRegime,
    label: REGIME_LABEL[e.taxRegime],
    taxName: TAX_NAME[e.taxRegime],
    ratePct: rate.times(100),
    income,
    expenses,
    base,
    calculated,
    minimum,
    forecast,
    minTaxApplied: minimum.gt(calculated),
    accrued: forecast.times(share),
  };
}

/**
 * График платежей на календарный год `now.year`: три авансовых (по итогам 3, 6 и 9 месяцев)
 * и итоговая уплата за год. Суммы по накопленным долям выручки.
 * Сроки: 28 апреля, 28 июля, 28 октября; итог за год для ООО до 28 марта, для ИП до 28 апреля
 * следующего года (день из справочника).
 */
export function incomeTaxSchedule(
  e: EntityInput,
  ctx: CalcCtx,
  selections: Selections,
  now: Moment,
): PaymentPoint[] {
  const tax = incomeTax(e, ctx, selections, now).forecast;
  const day = ctx.rules.paymentDay;
  const points: PaymentPoint[] = [];

  let prev = ZERO;
  for (const a of ADVANCES) {
    const cum = cumulativeShare(e, ctx, a.through, now);
    points.push({
      due: { year: now.year, month: a.dueMonth, day },
      period: a.period,
      periodLabel: PERIOD_LABEL[a.period],
      kind: 'advance',
      amount: tax.times(cum.minus(prev)),
    });
    prev = cum;
  }

  const finalMonth = e.taxRegime !== 'osno' && e.form === 'ИП' ? 3 : 2;
  points.push({
    due: { year: now.year + 1, month: finalMonth, day },
    period: 'year',
    periodLabel: PERIOD_LABEL.year,
    kind: 'final',
    amount: tax.times(dec(1).minus(prev)),
  });
  return points;
}

/** Ближайший платёж: первый срок не раньше сегодняшнего дня. */
export function nextPayment(schedule: PaymentPoint[], today: CalendarDay): PaymentPoint | null {
  return schedule.find((p) => compareDays(p.due, today) >= 0) ?? null;
}

export function sumAmounts(points: PaymentPoint[]): Dec {
  return sum(points.map((p) => p.amount));
}
