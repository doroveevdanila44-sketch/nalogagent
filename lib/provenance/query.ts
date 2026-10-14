import type { Period } from '@/lib/calc/period';
import type { ForecastScenario, TaxKind } from '@/lib/calc/service';
import type { Rate } from '@/lib/calc/types';
import { periodPhrase, scopeLabel } from './line';
import type { CalcSnapshot } from './snapshot';

/**
 * Запрос расчёта: те же аргументы, что у calcTax. Дашборд и чат не хранят цифры, они хранят запрос
 * или снимок, а расчёт всегда выполняет calcTax на сервере по одному снимку данных.
 */
export interface CalcQuery {
  tax: TaxKind;
  period: Period;
  entityIds: string[] | 'all';
  /** Ставка НДС вместо выбранной; на ОСНО не действует */
  rate?: Rate;
  /** Прогноз следующего года: выручка текущего года с ростом, правила как в текущем году */
  scenario?: ForecastScenario;
}

// ===== Ключ расчёта для отметок «сверил» =====

function periodKey(s: CalcSnapshot): string {
  const p = s.period;
  switch (p.kind) {
    case 'month':
      return `m${p.year}-${String(p.month).padStart(2, '0')}`;
    case 'quarter':
      return `q${p.year}-${p.quarter}`;
    case 'year':
      return `y${p.year}`;
    case 'ytd':
      return `ytd${s.asOf.slice(0, 4)}`;
    case 'range':
      return `r${p.from}_${p.to}`;
  }
}

/**
 * Ключ расчёта: налог, период, юрлица и ставка. Одинаков для одного и того же вопроса в разные
 * дни, поэтому отметка «сверил» не теряется, а сумма на момент отметки хранится рядом с ней.
 */
export function subjectOf(snaps: CalcSnapshot[]): string {
  return snaps
    .map((s) => {
      const scope = s.scope === 'all' ? 'all' : [...s.scope].sort().join('+');
      // ставки юрлиц в расчёте: смена выбранной ставки это уже другой расчёт, отметки к нему не переходят
      const rates = s.entities.filter((e) => e.applicable && e.rate !== null).map((e) => e.rate);
      // прогноз с другим ростом выручки это другой расчёт
      const growth = s.scenario ? `:g${s.scenario.growth}` : '';
      // сценарий «что если» это другой расчёт, чем тот же налог по данным
      const what = s.whatIf ? `:w${s.whatIf.role}:${s.whatIf.key}` : '';
      return `${s.tax}:${periodKey(s)}:${scope}:${rates.join(',')}${growth}${what}`;
    })
    .join('|');
}

// ===== Заголовок и имя файла =====

const TAX_WORD: Record<TaxKind, string> = {
  vat: 'НДС',
  usn: 'УСН',
  profit: 'Налог-на-прибыль',
};

const FORM_PREFIX = /^(ООО|ИП|АО|ЗАО|ПАО|ОАО)\s+/;

/** «ООО «Альфа»» это «Альфа»: в имени файла форма и кавычки не нужны. */
export function shortName(name: string): string {
  return name.replace(FORM_PREFIX, '').replace(/[«»"]/g, '').trim();
}

function periodSlug(s: CalcSnapshot): string {
  const p = s.period;
  switch (p.kind) {
    case 'month':
      return `${p.year}-${String(p.month).padStart(2, '0')}`;
    case 'quarter':
      return `${p.year}-${p.quarter}-кв`;
    case 'year':
      return `${p.year}`;
    case 'ytd':
      return `с-начала-года-по-${s.asOf}`;
    case 'range':
      return `${p.from}_${p.to}`;
  }
}

const unsafe = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Имя файла Excel: «НДС_Альфа_2026-02.xlsx». Несколько налогов или периодов дают «Расчёт» и год.
 */
export function exportFileName(snaps: CalcSnapshot[]): string {
  const first = snaps[0];
  if (!first) return 'Расчёт.xlsx';
  const taxes = [...new Set(snaps.map((s) => s.tax))];
  const tax =
    taxes.length === 1
      ? TAX_WORD[taxes[0]!]
      : taxes.length === 2 && taxes.includes('usn') && taxes.includes('profit')
        ? 'Налог-на-прибыль-и-УСН'
        : 'Расчёт';

  const names = new Set<string>();
  let whole = true;
  for (const s of snaps) {
    if (s.scope !== 'all') whole = false;
    for (const e of s.entities) if (e.applicable) names.add(shortName(e.name));
  }
  const label = scopeLabel(snaps);
  const scope =
    label === 'Вся группа' || (whole && names.size > 3) || names.size === 0
      ? 'Группа'
      : [...names].join('-');

  const periods = [...new Set(snaps.map(periodSlug))];
  const period = periods.length === 1 ? periods[0]! : first.asOf.slice(0, 4);

  return `${tax}_${scope}_${period}.xlsx`.replace(unsafe, '-').replace(/\s+/g, '-');
}

/** Заголовок для списка статусов: «НДС, ООО «Альфа», февраль 2026». */
export function requestTitle(snaps: CalcSnapshot[]): string {
  const names = [...new Set(snaps.map((s) => s.taxName))];
  const taxes = names.map((n, i) => (i === 0 ? n : n.charAt(0).toLowerCase() + n.slice(1))).join(' и ');
  const what = snaps.find((s) => s.whatIf?.role === 'scenario')?.whatIf;
  return `${taxes}, ${scopeLabel(snaps)}, ${periodPhrase(snaps)}${what ? `, сценарий: ${what.title}` : ''}`;
}
