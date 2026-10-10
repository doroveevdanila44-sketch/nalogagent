import { dec, D, ZERO, round2, sum, type Dec } from './decimal';
import { addDay, compareDays, daysInMonth, type CalendarDay, type Moment } from './time';
import type { CalcCtx, EntityInput, EntitySnapshot, Rate, Selections } from './types';
import { DEFAULT_RATE, OSNO_RATE } from './types';

const ONE = dec(1);

/**
 * Налог за период по ставке.
 *  5%:  R × 5 / 105
 *  7%:  R × 7 / 107
 *  22%: R × 22 / 122 × (1 − p), отрицательное значение это НДС к возмещению
 */
export function taxFor(rate: number, revenue: Dec, p: Dec, generalRate = 22): Dec {
  const base = revenue.times(rate).div(100 + rate);
  return rate === generalRate ? base.times(ONE.minus(p)) : base;
}

/** Доля закупок с НДС, выше которой общая ставка дешевле пониженной. Для 5% и 22% это около 73,6%. */
export function breakEvenShare(lowRate: number, generalRate = 22): Dec {
  const low = dec(lowRate).div(100 + lowRate);
  const general = dec(generalRate).div(100 + generalRate);
  return ONE.minus(low.div(general));
}

/** Накопленная доля годовой выручки на момент `m` по весам сезонности. */
export function frac(weights: Dec[], m: Moment): Dec {
  let acc = ZERO;
  for (let i = 0; i < m.month; i++) acc = acc.plus(weights[i]!);
  const past = dec(m.day - 1).plus(dec(m.secondsOfDay).div(86400));
  return acc.plus(weights[m.month]!.times(past).div(daysInMonth(m.year, m.month)));
}

/** Выручка месяца: факт (если есть и месяц уже прошёл) или годовой прогноз × вес. */
export function monthAmount(e: EntityInput, ctx: CalcCtx, month: number, now: Moment): Dec {
  if (month < now.month && e.monthly) {
    const f = e.monthly.find((x) => x.month === month && x.isFact);
    if (f) return f.amount;
  }
  return e.annualRevenue.times(ctx.weights[month]!);
}

/** Накопленная выручка с начала года на момент `now`. */
export function ytd(e: EntityInput, ctx: CalcCtx, now: Moment): Dec {
  let acc = ZERO;
  for (let i = 0; i < now.month; i++) acc = acc.plus(monthAmount(e, ctx, i, now));
  const past = dec(now.day - 1).plus(dec(now.secondsOfDay).div(86400));
  const cur = e.annualRevenue.times(ctx.weights[now.month]!).times(past).div(daysInMonth(now.year, now.month));
  return acc.plus(cur);
}

/**
 * Дата, когда накопленная выручка освобождённого юрлица достигает порога.
 * Накопление считается на конец дня. Налог начинается с первого числа следующего месяца.
 * null: плательщик или порог в этом году не будет достигнут.
 */
export function crossing(e: EntityInput, ctx: CalcCtx, now: Moment): CalendarDay | null {
  if (e.status === 'payer') return null;
  const limit = ctx.rules.vatExemptLimit;
  let cum = ZERO;
  for (let i = 0; i < now.month; i++) cum = cum.plus(monthAmount(e, ctx, i, now));
  cum = cum.plus(
    monthAmount(e, ctx, now.month, now).times(now.day).div(daysInMonth(now.year, now.month)),
  );
  const today: CalendarDay = { year: now.year, month: now.month, day: now.day };
  if (cum.gte(limit)) return today;

  let day = addDay(today);
  while (day.year === now.year) {
    cum = cum.plus(monthAmount(e, ctx, day.month, now).div(daysInMonth(day.year, day.month)));
    if (cum.gte(limit)) return day;
    day = addDay(day);
  }
  return null;
}

/** Налогооблагаемая выручка до конца года. */
export function baseRev(e: EntityInput, ctx: CalcCtx, now: Moment): Dec {
  if (e.status === 'payer') return e.annualRevenue;
  const c = crossing(e, ctx, now);
  if (!c) return ZERO;
  const startMonth = c.month + 1;
  if (startMonth > 11) return ZERO;
  let acc = ZERO;
  for (let i = startMonth; i < 12; i++) acc = acc.plus(monthAmount(e, ctx, i, now));
  return acc;
}

export function forecast(e: EntityInput, ctx: CalcCtx, rate: number, now: Moment): Dec {
  return taxFor(rate, baseRev(e, ctx, now), e.inputVatShare, ctx.rules.generalRate);
}

/** Ставка с минимальным прогнозом, при равенстве меньшая. На ОСНО ставка одна. */
export function bestRate(e: EntityInput, ctx: CalcCtx, now: Moment): Rate {
  if (e.taxRegime === 'osno') return OSNO_RATE;
  const base = baseRev(e, ctx, now);
  let best = ctx.rules.rates[0]!;
  let bestTax = taxFor(best, base, e.inputVatShare, ctx.rules.generalRate);
  for (const r of ctx.rules.rates.slice(1)) {
    const t = taxFor(r, base, e.inputVatShare, ctx.rules.generalRate);
    if (t.lt(bestTax)) {
      best = r;
      bestTax = t;
    }
  }
  return best;
}

export function selectedRate(e: EntityInput, selections: Selections): Rate {
  if (e.taxRegime === 'osno') return OSNO_RATE;
  const v = selections[e.id];
  return (v === 5 || v === 7 || v === 22 ? v : DEFAULT_RATE) as Rate;
}

/** Суммы по группе складываются из значений юрлиц, округлённых до копеек: на экране нет расхождения. */
export function groupTotal(values: Dec[]): Dec {
  return sum(values.map(round2));
}

/** Экономия по группе: сумма по юрлицам max(0, прогноз выбранной − прогноз лучшей). */
export function groupSaving(entities: EntityInput[], selections: Selections, ctx: CalcCtx, now: Moment): Dec {
  return groupTotal(
    entities.map((e) => {
      const f = forecast(e, ctx, selectedRate(e, selections), now);
      const m = forecast(e, ctx, bestRate(e, ctx, now), now);
      return D.max(ZERO, f.minus(m));
    }),
  );
}

export function snapshotEntity(e: EntityInput, selections: Selections, ctx: CalcCtx, now: Moment): EntitySnapshot {
  const y = ytd(e, ctx, now);
  const base = baseRev(e, ctx, now);
  const accrued: Record<number, Dec> = {};
  const fc: Record<number, Dec> = {};
  const full: Record<number, Dec> = {};
  for (const r of ctx.rules.rates) {
    accrued[r] = taxFor(r, y, e.inputVatShare, ctx.rules.generalRate);
    fc[r] = taxFor(r, base, e.inputVatShare, ctx.rules.generalRate);
    full[r] = taxFor(r, e.annualRevenue, e.inputVatShare, ctx.rules.generalRate);
  }
  return {
    id: e.id,
    selected: selectedRate(e, selections),
    best: bestRate(e, ctx, now),
    ytd: y,
    accrued,
    forecast: fc,
    fullYear: full,
    baseRev: base,
    crossing: crossing(e, ctx, now),
  };
}

export interface GroupTotals {
  ytd: Dec;
  /** НДС начислен с начала года: только плательщики, по выбранным ставкам */
  taxAccrued: Dec;
  forecast: Dec;
  saving: Dec;
  annual: Dec;
}

export function groupTotals(entities: EntityInput[], selections: Selections, ctx: CalcCtx, now: Moment): GroupTotals {
  return {
    ytd: groupTotal(entities.map((e) => ytd(e, ctx, now))),
    taxAccrued: groupTotal(
      entities
        .filter((e) => e.status === 'payer')
        .map((e) => taxFor(selectedRate(e, selections), ytd(e, ctx, now), e.inputVatShare, ctx.rules.generalRate)),
    ),
    forecast: groupTotal(entities.map((e) => forecast(e, ctx, selectedRate(e, selections), now))),
    saving: groupSaving(entities, selections, ctx, now),
    annual: groupTotal(entities.map((e) => e.annualRevenue)),
  };
}

export interface MonthColumn {
  month: number;
  status: 'fact' | 'current' | 'forecast';
  total: Dec;
  byEntity: { id: string; amount: Dec }[];
}

/** Выручка группы по месяцам для графика. */
export function monthlySeries(entities: EntityInput[], ctx: CalcCtx, now: Moment): MonthColumn[] {
  const cols: MonthColumn[] = [];
  for (let m = 0; m < 12; m++) {
    const byEntity = entities.map((e) => ({ id: e.id, amount: monthAmount(e, ctx, m, now) }));
    cols.push({
      month: m,
      status: m < now.month ? 'fact' : m === now.month ? 'current' : 'forecast',
      total: groupTotal(byEntity.map((x) => x.amount)),
      byEntity,
    });
  }
  return cols;
}

export { compareDays };
