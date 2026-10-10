import { dec, type Dec } from './decimal';
import type { Moment } from './time';
import { toIsoDate } from './time';
import type { Rate, RuleSet } from './types';

/** Строка таблицы rules. Числа приходят строками из numeric. */
export interface RuleRow {
  key: string;
  value: string | null;
  formula: string | null;
  unit: string;
  validFrom: string;
  validTo: string | null;
  norm?: string | null;
  sourceUrl?: string | null;
  note?: string | null;
}

/** Правило, действовавшее на дату: самая поздняя valid_from не позже даты, valid_to не раньше даты. */
export function resolveRule(rows: RuleRow[], key: string, onDate: string): RuleRow | null {
  let best: RuleRow | null = null;
  for (const r of rows) {
    if (r.key !== key) continue;
    if (r.validFrom > onDate) continue;
    if (r.validTo !== null && r.validTo < onDate) continue;
    if (!best || r.validFrom > best.validFrom) best = r;
  }
  return best;
}

function numeric(row: RuleRow | null): Dec | null {
  return row && row.value !== null ? dec(row.value) : null;
}

function formulaBase(row: RuleRow | null): Dec | null {
  const m = row?.formula?.match(/^\s*(\d+(?:\.\d+)?)\s*\*\s*deflator\s*$/);
  return m ? dec(m[1]!) : null;
}

export class MissingRuleError extends Error {
  constructor(key: string, onDate: string) {
    super(`Нет правила «${key}» на дату ${onDate}. Добавьте запись в справочник rules.`);
    this.name = 'MissingRuleError';
  }
}

/**
 * Собирает набор правил на момент `now`. Пересчёт задним числом берёт правила того периода:
 * достаточно передать момент нужного года.
 */
export function buildRuleSet(rows: RuleRow[], now: Moment): RuleSet {
  const onDate = toIsoDate(now);
  const need = (key: string): RuleRow => {
    const r = resolveRule(rows, key, onDate);
    if (!r) throw new MissingRuleError(key, onDate);
    return r;
  };

  const exempt = numeric(need('vat_exempt_limit'));
  if (!exempt) throw new MissingRuleError('vat_exempt_limit', onDate);

  const r5 = resolveRule(rows, 'rate_special_5', onDate);
  const r7 = resolveRule(rows, 'rate_special_7', onDate);
  const rg = resolveRule(rows, 'rate_general', onDate);
  const rates = [numeric(r5), numeric(r7), numeric(rg)]
    .filter((v): v is Dec => v !== null)
    .map((v) => v.toNumber() as Rate)
    .sort((a, b) => a - b);

  const limit5Row = resolveRule(rows, 'limit_5', onDate);
  const limit7Row = resolveRule(rows, 'limit_7', onDate);

  const nextDate = `${now.year + 1}-01-01`;
  const next5 = resolveRule(rows, 'limit_5', nextDate);
  const next7 = resolveRule(rows, 'limit_7', nextDate);
  const deflatorKnown = numeric(next5) !== null && numeric(next7) !== null;

  const twelve = numeric(resolveRule(rows, 'twelve_quarters', onDate));
  const windowRow = resolveRule(rows, 'rate_window', onDate);
  const windowMonths = windowRow?.note
    ? windowRow.note.split(',').map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 12)
    : [11, 12];
  const signs = resolveRule(rows, 'group_unity_signs', onDate);

  return {
    asOf: onDate,
    year: now.year,
    vatExemptLimit: exempt,
    limit5: numeric(limit5Row),
    limit7: numeric(limit7Row),
    rates: rates.length === 3 ? rates : [5, 7, 22],
    generalRate: numeric(rg)?.toNumber() ?? 22,
    twelveQuarters: twelve?.toNumber() ?? 12,
    rateWindowMonths: windowMonths,
    nextYear: {
      year: now.year + 1,
      deflatorKnown,
      base5: formulaBase(next5),
      base7: formulaBase(next7),
    },
    groupSigns: signs?.note ?? null,
  };
}
