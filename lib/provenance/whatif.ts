import {
  dateRu,
  dec,
  mln,
  pct,
  rub,
  compareDays,
  type CalendarDay,
  type Dec,
  type WhatIfComparison,
  type WhatIfEntityRow,
} from '@/lib/calc';
import { shortName } from './query';

/**
 * Сравнение «сейчас и по сценарию» в виде для сети и базы: деньги и доли строками. Строится из
 * WhatIfComparison один раз, дальше ни одно число здесь не пересчитывается (только разница двух
 * готовых значений для подписи). По этим данным ответ агента, панель «Показать расчёт» и Excel
 * показывают одни и те же цифры и одни и те же фразы.
 */

export interface PairS {
  base: string | null;
  scenario: string | null;
}

export interface ThresholdS {
  /** Дата пересечения порога в этом году; null: порог не пересекается */
  crossing: CalendarDay | null;
  /** Пересечение уже случилось к дате расчёта */
  already: boolean;
  /** Первый месяц с НДС: год и месяц 0..11 */
  vatFrom: { year: number; month: number } | null;
}

export interface WhatIfRowSnapshot {
  entityId: string;
  name: string;
  /** Налог с доходов по режиму: УСН или налог на прибыль */
  incomeTaxKind: 'usn' | 'profit';
  vatStatus: 'payer' | 'exempt';
  revenue: PairS;
  vat: PairS;
  incomeTax: PairS;
  taxes: PairS;
  threshold: { limit: string; base: ThresholdS; scenario: ThresholdS } | null;
  limit5: { limit: string; base: string; scenario: string } | null;
}

export interface WhatIfSnapshot {
  v: 1;
  /** Вид изменения: машины, процент, сумма */
  kind: 'cars' | 'growth' | 'amount';
  title: string;
  key: string;
  year: number;
  /** «с ноября по декабрь 2026» */
  monthsLabel: string;
  noChange: boolean;
  assumptions: string[];
  rows: WhatIfRowSnapshot[];
  totals: { revenue: PairS; vat: PairS; incomeTax: PairS; taxes: PairS };
  unified: {
    signs: string;
    limit: string;
    count: number;
    revenue: PairS;
    share: { base: string; scenario: string };
  } | null;
}

const s = (v: Dec | null): string | null => (v === null ? null : v.toString());
const pair = (p: { base: Dec | null; scenario: Dec | null }): PairS => ({ base: s(p.base), scenario: s(p.scenario) });

export function toWhatIfSnapshot(c: WhatIfComparison): WhatIfSnapshot {
  const today = c.today;
  const state = (t: { crossing: CalendarDay | null; vatFrom: { year: number; month: number } | null }): ThresholdS => ({
    crossing: t.crossing,
    already: t.crossing !== null && compareDays(t.crossing, today) <= 0,
    vatFrom: t.vatFrom,
  });
  return {
    v: 1,
    kind: c.spec.request.kind,
    title: c.title,
    key: c.key,
    year: c.year,
    monthsLabel: c.monthsLabel,
    noChange: c.noChange,
    assumptions: c.assumptions,
    rows: c.rows.map((r: WhatIfEntityRow) => ({
      entityId: r.entityId,
      name: r.name,
      incomeTaxKind: r.incomeTaxKind,
      vatStatus: r.vatStatus,
      revenue: pair(r.revenue),
      vat: pair(r.vat),
      incomeTax: pair(r.incomeTax),
      taxes: pair(r.taxes),
      threshold: r.threshold
        ? { limit: r.threshold.limit.toString(), base: state(r.threshold.base), scenario: state(r.threshold.scenario) }
        : null,
      limit5: r.limit5
        ? { limit: r.limit5.limit.toString(), base: r.limit5.base.toString(), scenario: r.limit5.scenario.toString() }
        : null,
    })),
    totals: {
      revenue: pair(c.totals.revenue),
      vat: pair(c.totals.vat),
      incomeTax: pair(c.totals.incomeTax),
      taxes: pair(c.totals.taxes),
    },
    unified: c.unified
      ? {
          signs: c.unified.signs,
          limit: c.unified.limit.toString(),
          count: c.unified.count,
          revenue: pair(c.unified.revenue),
          share: { base: c.unified.share.base!.toString(), scenario: c.unified.share.scenario!.toString() },
        }
      : null,
  };
}

// ===== Фразы и таблицы =====

/** Сумма в строке: от миллиона «1,25 млн», меньше точными рублями. */
export function money(v: string | number | Dec | null): string {
  if (v === null) return 'нет данных';
  const d = dec(v);
  return d.abs().gte(1_000_000) ? mln(d, 2) : rub(d);
}

/** Разница: «+0,07 млн», «−23 810 ₽», «0 ₽». */
export function signedMoney(v: Dec): string {
  if (v.isZero()) return rub(0);
  return `${v.gt(0) ? '+' : '−'}${money(v.abs())}`;
}

function diff(p: PairS): Dec | null {
  return p.base === null || p.scenario === null ? null : dec(p.scenario).minus(p.base);
}

export function diffText(p: PairS): string {
  const d = diff(p);
  return d === null ? 'нет данных' : signedMoney(d);
}

/** Название налога с доходов в середине фразы: по режимам юрлиц сценария. */
export function incomeTaxWord(rows: { incomeTaxKind: 'usn' | 'profit' }[]): string {
  const kinds = new Set(rows.map((r) => r.incomeTaxKind));
  if (kinds.size === 2) return 'налог на прибыль и УСН';
  return kinds.has('profit') ? 'налог на прибыль' : 'налог по УСН';
}

/** То же в заголовке строки таблицы. */
export function incomeTaxTitle(rows: { incomeTaxKind: 'usn' | 'profit' }[]): string {
  const w = incomeTaxWord(rows);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)} за год`;
}

export interface TableS {
  head: string[];
  rows: string[][];
  totalRow?: boolean;
  /** Узкая таблица для чата: плотные поля */
  dense?: boolean;
}

/** Название налога с доходов в строке таблицы, без «за год»: таблица вся за год. */
function incomeTaxRow(rows: { incomeTaxKind: 'usn' | 'profit' }[]): string {
  const w = incomeTaxWord(rows);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
}

/** Показатели за год: итог по юрлицам сценария, сейчас и по сценарию. */
export function summaryTable(w: WhatIfSnapshot): TableS {
  const line = (label: string, p: PairS) => [label, money(p.base), money(p.scenario), diffText(p)];
  return {
    head: ['За год', 'Сейчас', 'По сценарию', 'Разница'],
    rows: [
      line('Выручка', w.totals.revenue),
      line('НДС', w.totals.vat),
      line(incomeTaxRow(w.rows), w.totals.incomeTax),
      line('Налоги всего', w.totals.taxes),
    ],
    totalRow: true,
    dense: true,
  };
}

/** Налоги по юрлицам: когда в сценарии больше одного юрлица. */
export function entityTable(w: WhatIfSnapshot): TableS | null {
  if (w.rows.length < 2) return null;
  const rows = w.rows.map((r) => [r.name, money(r.taxes.base), money(r.taxes.scenario), diffText(r.taxes)]);
  rows.push(['Всего', money(w.totals.taxes.base), money(w.totals.taxes.scenario), diffText(w.totals.taxes)]);
  return { head: ['Налоги', 'Сейчас', 'По сценарию', 'Разница'], rows, totalRow: true, dense: true };
}

const MONTH_START = (y: number, m: number, today: number) =>
  `1 ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m]}${y === today ? '' : ` ${y}`}`;

function startOf(t: ThresholdS, year: number): string | null {
  return t.vatFrom ? MONTH_START(t.vatFrom.year, t.vatFrom.month, year) : null;
}

/** Порог освобождения: новая дата пересечения и месяц, с которого начнётся НДС. */
export function thresholdLine(r: WhatIfRowSnapshot, year: number): string | null {
  const t = r.threshold;
  if (!t) return null;
  const limit = mln(dec(t.limit), 0);
  const b = t.base;
  const n = t.scenario;
  if (!b.crossing && !n.crossing) {
    return `${r.name}: порог ${limit} не пересекается, выручка года ${money(r.revenue.base)} → ${money(r.revenue.scenario)}, НДС в ${year} году не начнётся.`;
  }
  if (b.crossing && n.crossing) {
    const was = startOf(b, year)!;
    const now = startOf(n, year)!;
    if (b.already && n.already) {
      return `${r.name}: порог ${limit} уже пересечён, НДС с ${now}, сценарий этого не меняет.`;
    }
    const tail = was === now ? `${now}, как и сейчас` : `${now} вместо ${was}`;
    return `${r.name}: порог ${limit} пересекается ${dateRu(b.crossing)} → ${dateRu(n.crossing)}, НДС начнётся с ${tail}.`;
  }
  if (!b.crossing && n.crossing) {
    return `${r.name}: порог ${limit} теперь пересекается около ${dateRu(n.crossing)} (сейчас не пересекается), НДС начнётся с ${startOf(n, year)}.`;
  }
  return `${r.name}: порог ${limit} в ${year} году не пересекается (сейчас около ${dateRu(b.crossing!)}), НДС в этом году не начнётся.`;
}

/** Плательщики: доля лимита ставки 5%. Одна строка на все юрлица сценария. */
export function limitLine(rows: WhatIfRowSnapshot[]): string | null {
  const list = rows.filter((r) => r.limit5);
  if (list.length === 0) return null;
  const limit = mln(dec(list[0]!.limit5!.limit), 1);
  const parts = list.map((r) => `${shortName(r.name)} ${pct(dec(r.limit5!.base), 1)} → ${pct(dec(r.limit5!.scenario), 1)}`);
  return `Доля лимита ставки 5% (${limit}) по выручке года: ${parts.join(', ')}.`;
}

/** Флаг «Признаки единого бизнеса»: сумма выручки юрлиц на УСН и доля от лимита. */
export function unifiedLine(w: WhatIfSnapshot): string | null {
  const u = w.unified;
  if (!u) return null;
  return (
    `Признаки единого бизнеса: ${u.signs}. Выручка юрлиц на УСН за год в сумме ${money(u.revenue.base)} → ` +
    `${money(u.revenue.scenario)}, это ${pct(dec(u.share.base), 1)} → ${pct(dec(u.share.scenario), 1)} ` +
    `от лимита ставки 5% (${mln(dec(u.limit), 1)}).`
  );
}

/** «НДС и налог по УСН», «НДС, налог на прибыль и УСН»: что входит в итог налогов. */
export function taxesWord(rows: { incomeTaxKind: 'usn' | 'profit' }[]): string {
  const w = incomeTaxWord(rows);
  return w === 'налог на прибыль и УСН' ? 'НДС, налог на прибыль и УСН' : `НДС и ${w}`;
}

/** Сумма в фразе о заданном изменении: «3 млн», «1,5 млн», «450 000 ₽». */
export function amountWord(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000 && a % 1_000_000 === 0) return mln(a, 0);
  if (a >= 1_000_000 && a % 100_000 === 0) return mln(a, 1);
  return money(a);
}

/** «НДС за год: 0 ₽ → 23 810 ₽ (+23 810 ₽)» или «… 0 ₽, без изменений». */
export function pairLine(label: string, p: PairS): string {
  const d = diff(p);
  if (d !== null && d.isZero()) return `${label}: ${money(p.base)}, без изменений`;
  return `${label}: ${money(p.base)} → ${money(p.scenario)} (${diffText(p)})`;
}

/** Итоговая строка: «выгоднее» или «дороже на N ₽» по налогам за год. */
export function verdictLine(w: WhatIfSnapshot): string | null {
  const d = diff(w.totals.taxes);
  if (d === null) return null;
  const head =
    `Итого по налогам за год (${taxesWord(w.rows)}): ` +
    `${money(w.totals.taxes.base)} → ${money(w.totals.taxes.scenario)}.`;
  if (d.isZero()) return `${head} Налоги не меняются.`;
  return `${head} По сценарию ${d.gt(0) ? 'дороже' : 'выгоднее'} на ${rub(d.abs())}.`;
}
