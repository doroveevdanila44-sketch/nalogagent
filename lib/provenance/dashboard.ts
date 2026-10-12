import type { CalcData } from '@/lib/calc/service';
import type { DashboardPayload } from '@/lib/calc/serialize';
import type { Rate, TaxRegime } from '@/lib/calc/types';
import { lineFromSnapshots, type SourceLineData } from './line';
import type { CalcQuery } from './query';
import { runQueries } from './schemas';
import type { CalcSnapshot } from './snapshot';

/**
 * Что стоит за цифрами дашборда. Сами цифры на экране считает клиент по входу калькулятора, а
 * происхождение каждой группы цифр (источник, период, обновление, факт или прогноз) берётся из
 * результатов calcTax. Здесь же описано, какие запросы расчёта относятся к баннеру и к карточке
 * юрлица: по ним кнопки действий открывают панель, Excel и проверку.
 */

export type BannerId = 'revenue' | 'vat' | 'vatForecast' | 'profit';

export const BANNER_IDS: readonly BannerId[] = ['revenue', 'vat', 'vatForecast', 'profit'];

export interface EntityLines {
  /** Под выручкой с начала года и прогнозом года */
  metrics: SourceLineData;
  /** Под ставками НДС */
  vat: SourceLineData;
  /** Под налогом на прибыль или УСН */
  income: SourceLineData;
  /** Цифры блока ставок условные: юрлицо освобождено от НДС и налог пока не начисляется */
  conditional: boolean;
}

/** Месяц в разбивке баннера: налог из результата calcTax и пометка, факт это или прогноз. */
export interface BreakdownMonth {
  /** «янв», «фев»... */
  short: string;
  /** «январь 2026» */
  label: string;
  /** fact: месяц закрыт, partial: идёт, forecast: прогноз по сезонности */
  status: 'fact' | 'partial' | 'forecast';
  /** Налог месяца по группе (НДС, у баннера прибыли налог на прибыль) */
  amount: string | null;
  /** У баннера прибыли: налог по УСН за тот же месяц */
  extra: string | null;
}

/** Разбивка по месяцам для баннеров «НДС за год» и «Налог на прибыль за год». */
export interface BannerBreakdown {
  months: BreakdownMonth[];
}

export interface DashboardProvenance {
  year: number;
  banners: Record<BannerId, SourceLineData>;
  chart: SourceLineData;
  entities: Record<string, EntityLines>;
  /** Месяцы факт и прогноз, из тех же расчётов calcTax за год */
  breakdown: Record<'vatForecast' | 'profit', BannerBreakdown>;
}

export type DashboardResponse = DashboardPayload & { provenance: DashboardProvenance };

const YTD = { kind: 'ytd' } as const;

/** Запросы расчёта для баннера группы. */
export function bannerQueries(id: BannerId, year: number): CalcQuery[] {
  const yearPeriod = { kind: 'year', year } as const;
  switch (id) {
    case 'revenue':
    case 'vat':
      return [{ tax: 'vat', period: YTD, entityIds: 'all' }];
    case 'vatForecast':
      return [{ tax: 'vat', period: yearPeriod, entityIds: 'all' }];
    case 'profit':
      return [
        { tax: 'profit', period: yearPeriod, entityIds: 'all' },
        { tax: 'usn', period: yearPeriod, entityIds: 'all' },
      ];
  }
}

/** Запросы расчёта для карточки юрлица: НДС и налог режима, с начала года и за год. */
export function entityQueries(
  e: { id: string; taxRegime: TaxRegime; selected: number },
  year: number,
): CalcQuery[] {
  const rate = e.taxRegime === 'osno' ? undefined : (e.selected as Rate);
  const income = e.taxRegime === 'osno' ? 'profit' : 'usn';
  const yearPeriod = { kind: 'year', year } as const;
  const base = { entityIds: [e.id], ...(rate ? { rate } : {}) };
  return [
    { tax: 'vat', period: YTD, ...base },
    { tax: 'vat', period: yearPeriod, ...base },
    { tax: income, period: YTD, ...base },
    { tax: income, period: yearPeriod, ...base },
  ];
}

const only = (s: CalcSnapshot, id: string): CalcSnapshot => ({
  ...s,
  entities: s.entities.filter((e) => e.entityId === id),
  scope: [id],
});

/** Строки происхождения для дашборда по снимку данных на момент `at`. */
export function buildDashboardProvenance(data: CalcData, tz: string, at: number): DashboardProvenance {
  const year = data.today.year;
  const yearPeriod = { kind: 'year', year } as const;
  const run = (tax: CalcQuery['tax'], period: CalcQuery['period']) =>
    runQueries(data, [{ tax, period, entityIds: 'all' }], { at, tz })[0]!;

  const vatYtd = run('vat', YTD);
  const vatYear = run('vat', yearPeriod);
  const usnYtd = run('usn', YTD);
  const usnYear = run('usn', yearPeriod);
  const profitYtd = run('profit', YTD);
  const profitYear = run('profit', yearPeriod);

  const banners: Record<BannerId, SourceLineData> = {
    revenue: lineFromSnapshots([vatYtd]),
    vat: lineFromSnapshots([vatYtd]),
    vatForecast: lineFromSnapshots([vatYear]),
    profit: lineFromSnapshots([profitYear, usnYear]),
  };

  const entities: Record<string, EntityLines> = {};
  for (const e of data.entities) {
    const vat = lineFromSnapshots([only(vatYtd, e.id), only(vatYear, e.id)]);
    const own = e.taxRegime === 'osno' ? [profitYtd, profitYear] : [usnYtd, usnYear];
    const conditional = e.status === 'exempt';
    entities[e.id] = {
      metrics: vat,
      vat,
      income: lineFromSnapshots(own.map((s) => only(s, e.id))),
      conditional,
    };
  }

  // Разбивка по месяцам: налог каждого месяца группы из расчёта за год, статус месяца оттуда же
  const monthsOf = (main: CalcSnapshot, extra?: CalcSnapshot): BreakdownMonth[] =>
    main.months.map((m, i) => ({
      short: m.label.split(' ')[0]!.slice(0, 3),
      label: m.label,
      status: m.status,
      amount: m.tax,
      extra: extra?.months[i]?.tax ?? null,
    }));

  return {
    year,
    banners,
    chart: lineFromSnapshots([vatYear]),
    entities,
    breakdown: {
      vatForecast: { months: monthsOf(vatYear) },
      profit: { months: monthsOf(profitYear, usnYear) },
    },
  };
}
