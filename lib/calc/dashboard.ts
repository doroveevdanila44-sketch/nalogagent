import {
  bestRate,
  baseRev,
  crossing,
  groupTotal,
  groupTotals,
  monthlySeries,
  selectedRate,
  taxFor,
  ytd,
  type MonthColumn,
} from './calc';
import type { Dec } from './decimal';
import { ZERO } from './decimal';
import {
  incomeTax,
  incomeTaxSchedule,
  nextPayment,
  yearTotal,
  type IncomeTaxResult,
  type PaymentPoint,
} from './income-tax';
import type { Moment, CalendarDay } from './time';
import type { DashboardInput, Warning } from './types';
import { buildWarnings, warningCounter } from './warnings';

/** Блок «Налог на прибыль или УСН» по юрлицу. */
export interface IncomeTaxBlock {
  regime: IncomeTaxResult['regime'];
  label: string;
  taxName: string;
  ratePct: Dec;
  income: Dec;
  expenses: Dec;
  base: Dec;
  forecast: Dec;
  minimum: Dec;
  minTaxApplied: boolean;
  schedule: PaymentPoint[];
  next: PaymentPoint | null;
}

/** Часть модели, которая меняется не чаще раза в сутки или при смене ставки. */
export interface StaticModel {
  warnings: Warning[];
  counter: string;
  columns: MonthColumn[];
  forecastGroup: Dec;
  saving: Dec;
  annualGroup: Dec;
  /** Налог на прибыль юрлиц на ОСНО, налог по УСН и итог за год */
  incomeTaxGroup: { profit: Dec; usn: Dec; total: Dec };
  perEntity: Record<
    string,
    {
      best: number;
      selected: number;
      forecast: Record<number, Dec>;
      fullYear: Record<number, Dec>;
      crossing: CalendarDay | null;
      baseRev: Dec;
      yearTotal: Dec;
      incomeTax: IncomeTaxBlock;
    }
  >;
}

/** «Живая» часть: пересчитывается каждую секунду на клиенте, без запросов к серверу. */
export interface LiveModel {
  ytdGroup: Dec;
  taxAccruedGroup: Dec;
  perEntity: Record<
    string,
    {
      ytd: Dec;
      /** НДС с начала года по каждой ставке (условно для освобождённых) */
      accrued: Record<number, Dec>;
      /** Налог на прибыль или УСН, начислено на сейчас */
      incomeTaxAccrued: Dec;
    }
  >;
}

export function computeStatic(input: DashboardInput, now: Moment): StaticModel {
  const { entities, selections, ctx } = input;
  const totals = groupTotals(entities, selections, ctx, now);
  const warnings = buildWarnings(entities, selections, ctx, now);
  const perEntity: StaticModel['perEntity'] = {};
  const profit: Dec[] = [];
  const usn: Dec[] = [];

  for (const e of entities) {
    const base = baseRev(e, ctx, now);
    const fc: Record<number, Dec> = {};
    const full: Record<number, Dec> = {};
    for (const r of ctx.rules.rates) {
      fc[r] = taxFor(r, base, e.inputVatShare, ctx.rules.generalRate);
      full[r] = taxFor(r, e.annualRevenue, e.inputVatShare, ctx.rules.generalRate);
    }
    const tax = incomeTax(e, ctx, selections, now);
    const schedule = incomeTaxSchedule(e, ctx, selections, now);
    (e.taxRegime === 'osno' ? profit : usn).push(tax.forecast);

    perEntity[e.id] = {
      best: bestRate(e, ctx, now),
      selected: selectedRate(e, selections),
      forecast: fc,
      fullYear: full,
      crossing: crossing(e, ctx, now),
      baseRev: base,
      yearTotal: yearTotal(e, ctx, now),
      incomeTax: {
        regime: tax.regime,
        label: tax.label,
        taxName: tax.taxName,
        ratePct: tax.ratePct,
        income: tax.income,
        expenses: tax.expenses,
        base: tax.base,
        forecast: tax.forecast,
        minimum: tax.minimum,
        minTaxApplied: tax.minTaxApplied,
        schedule,
        next: nextPayment(schedule, { year: now.year, month: now.month, day: now.day }),
      },
    };
  }

  const profitTotal = groupTotal(profit);
  const usnTotal = groupTotal(usn);

  return {
    warnings,
    counter: warningCounter(warnings),
    columns: monthlySeries(entities, ctx, now),
    forecastGroup: totals.forecast,
    saving: totals.saving,
    annualGroup: totals.annual,
    incomeTaxGroup: { profit: profitTotal, usn: usnTotal, total: profitTotal.plus(usnTotal) },
    perEntity,
  };
}

/**
 * Живые значения. Налог на прибыль и УСН начисляется пропорционально накопленной выручке
 * (прогноз года из статической части × доля накопленной выручки), поэтому второй раз
 * его не пересчитывают.
 */
export function computeLive(input: DashboardInput, now: Moment, stat: StaticModel): LiveModel {
  const { entities, selections, ctx } = input;
  const perEntity: LiveModel['perEntity'] = {};
  const ytds: Dec[] = [];
  const vat: Dec[] = [];

  for (const e of entities) {
    const y = ytd(e, ctx, now);
    ytds.push(y);
    const accrued: Record<number, Dec> = {};
    for (const r of ctx.rules.rates) accrued[r] = taxFor(r, y, e.inputVatShare, ctx.rules.generalRate);
    if (e.status === 'payer') vat.push(accrued[selectedRate(e, selections)]!);

    const s = stat.perEntity[e.id];
    const total = s?.yearTotal ?? ZERO;
    const share = total.isZero() ? ZERO : y.div(total);
    perEntity[e.id] = {
      ytd: y,
      accrued,
      incomeTaxAccrued: (s?.incomeTax.forecast ?? ZERO).times(share),
    };
  }
  return { ytdGroup: groupTotal(ytds), taxAccruedGroup: groupTotal(vat), perEntity };
}
