import {
  bestRate,
  baseRev,
  crossing,
  groupTotals,
  monthlySeries,
  selectedRate,
  taxFor,
  ytd,
  type MonthColumn,
} from './calc';
import type { Dec } from './decimal';
import type { Moment, CalendarDay } from './time';
import type { DashboardInput, Warning } from './types';
import { buildWarnings, warningCounter } from './warnings';

/** Часть модели, которая меняется не чаще раза в сутки или при смене ставки. */
export interface StaticModel {
  warnings: Warning[];
  counter: string;
  columns: MonthColumn[];
  forecastGroup: Dec;
  saving: Dec;
  annualGroup: Dec;
  perEntity: Record<
    string,
    {
      best: number;
      selected: number;
      forecast: Record<number, Dec>;
      fullYear: Record<number, Dec>;
      crossing: CalendarDay | null;
      baseRev: Dec;
    }
  >;
}

/** «Живая» часть: пересчитывается каждую секунду на клиенте, без запросов к серверу. */
export interface LiveModel {
  ytdGroup: Dec;
  taxAccruedGroup: Dec;
  perEntity: Record<string, { ytd: Dec; accrued: Record<number, Dec> }>;
}

export function computeStatic(input: DashboardInput, now: Moment): StaticModel {
  const { entities, selections, ctx } = input;
  const totals = groupTotals(entities, selections, ctx, now);
  const warnings = buildWarnings(entities, selections, ctx, now);
  const perEntity: StaticModel['perEntity'] = {};
  for (const e of entities) {
    const base = baseRev(e, ctx, now);
    const fc: Record<number, Dec> = {};
    const full: Record<number, Dec> = {};
    for (const r of ctx.rules.rates) {
      fc[r] = taxFor(r, base, e.inputVatShare, ctx.rules.generalRate);
      full[r] = taxFor(r, e.annualRevenue, e.inputVatShare, ctx.rules.generalRate);
    }
    perEntity[e.id] = {
      best: bestRate(e, ctx, now),
      selected: selectedRate(e, selections),
      forecast: fc,
      fullYear: full,
      crossing: crossing(e, ctx, now),
      baseRev: base,
    };
  }
  return {
    warnings,
    counter: warningCounter(warnings),
    columns: monthlySeries(entities, ctx, now),
    forecastGroup: totals.forecast,
    saving: totals.saving,
    annualGroup: totals.annual,
    perEntity,
  };
}

export function computeLive(input: DashboardInput, now: Moment): LiveModel {
  const { entities, selections, ctx } = input;
  const totals = groupTotals(entities, selections, ctx, now);
  const perEntity: LiveModel['perEntity'] = {};
  for (const e of entities) {
    const y = ytd(e, ctx, now);
    const accrued: Record<number, Dec> = {};
    for (const r of ctx.rules.rates) accrued[r] = taxFor(r, y, e.inputVatShare, ctx.rules.generalRate);
    perEntity[e.id] = { ytd: y, accrued };
  }
  return { ytdGroup: totals.ytd, taxAccruedGroup: totals.taxAccrued, perEntity };
}
