import { ENTITY_COLORS } from '@/lib/theme';
import { dec, round2, type Dec } from './decimal';
import type { RuleRow } from './rules';
import { buildRuleSet } from './rules';
import type { Moment } from './time';
import type { CalcCtx, DashboardInput, EntityInput, Selections } from './types';

/** Веса сезонности из CALC.md */
export const SEED_WEIGHTS = ['.07', '.07', '.07', '.05', '.06', '.09', '.13', '.14', '.10', '.06', '.05', '.11'].map(dec);

/**
 * Выдуманные данные демо (CALC.md, «Контрольные числа»). Все юрлица и цифры условные.
 * Эпсилон добавлена как пример ОСНО: НДС 22% с вычетами и налог на прибыль.
 */
export const SEED_ENTITIES: EntityInput[] = [
  {
    id: 'alfa', name: 'ООО «Альфа»', form: 'ООО', ownerLabel: 'Собственник 1', status: 'payer',
    annualRevenue: dec(28_400_000), inputVatShare: dec('0.82'), color: ENTITY_COLORS.alfa!,
    description: 'Аренда без экипажа: люкс и внедорожники',
    taxRegime: 'usn_income', usnRate: dec('0.06'), annualExpenses: dec(0),
    revenuePerCarMonthly: dec(180_000), activity: 'rent_no_crew',
  },
  {
    id: 'beta', name: 'ИП Бета', form: 'ИП', ownerLabel: 'Собственник 1', status: 'payer',
    annualRevenue: dec(22_000_000), inputVatShare: dec('0.34'), color: ENTITY_COLORS.beta!,
    description: 'Аренда без экипажа: комфорт и внедорожники',
    taxRegime: 'usn_income_expense', usnRate: dec('0.15'), annualExpenses: dec(15_400_000),
    revenuePerCarMonthly: dec(150_000), activity: 'rent_no_crew',
  },
  {
    id: 'delta', name: 'ИП Дельта', form: 'ИП', ownerLabel: 'Собственник 2', status: 'exempt',
    annualRevenue: dec(20_900_000), inputVatShare: dec('0.18'), color: ENTITY_COLORS.delta!,
    description: 'Аренда без экипажа: комфорт',
    taxRegime: 'usn_income', usnRate: dec('0.06'), annualExpenses: dec(0),
    revenuePerCarMonthly: dec(130_000), activity: 'rent_no_crew',
  },
  {
    id: 'gamma', name: 'ООО «Гамма»', form: 'ООО', ownerLabel: 'Собственник 2', status: 'exempt',
    annualRevenue: dec(6_400_000), inputVatShare: dec('0.80'), color: ENTITY_COLORS.gamma!,
    description: 'Аренда с экипажем и трансферы',
    taxRegime: 'usn_income_expense', usnRate: dec('0.15'), annualExpenses: dec(5_200_000),
    revenuePerCarMonthly: dec(160_000), activity: 'rent_with_crew',
  },
  {
    id: 'epsilon', name: 'ООО «Эпсилон»', form: 'ООО', ownerLabel: 'Собственник 1', status: 'payer',
    annualRevenue: dec(74_000_000), inputVatShare: dec('0.55'), color: ENTITY_COLORS.epsilon!,
    description: 'Условное юрлицо на ОСНО',
    taxRegime: 'osno', usnRate: null, annualExpenses: dec(44_000_000),
    revenuePerCarMonthly: dec(170_000), activity: 'other',
  },
];

/** Строки таблицы rules из schema.sql */
export const SEED_RULE_ROWS: RuleRow[] = [
  { key: 'vat_exempt_limit', value: '20000000', formula: null, unit: 'rub', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 145', note: 'Порог освобождения' },
  { key: 'limit_5', value: '272500000', formula: null, unit: 'rub', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 164', note: 'Верхняя граница для ставки 5%' },
  { key: 'limit_7', value: '490500000', formula: null, unit: 'rub', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 164', note: 'Верхняя граница для ставки 7%' },
  { key: 'rate_special_5', value: '5', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 164', note: 'Без вычетов' },
  { key: 'rate_special_7', value: '7', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 164', note: 'Без вычетов' },
  { key: 'rate_general', value: '22', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 164', note: 'С вычетами' },
  { key: 'twelve_quarters', value: '12', formula: null, unit: 'count', validFrom: '2026-01-01', validTo: '2026-12-31', norm: null, note: 'Ограничение возврата к прежней ставке' },
  { key: 'profit_tax_rate', value: '25', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 284', note: 'Налог на прибыль. Проверить с бухгалтером' },
  { key: 'usn_rate_income', value: '6', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 346.20, п. 1', note: 'УСН «доходы». Проверить с бухгалтером' },
  { key: 'usn_rate_income_expense', value: '15', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 346.20, п. 2', note: 'УСН «доходы минус расходы». Проверить с бухгалтером' },
  { key: 'usn_min_tax_rate', value: '1', formula: null, unit: 'percent', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 346.18, п. 6', note: 'Минимальный налог УСН от доходов. Проверить с бухгалтером' },
  { key: 'payment_day', value: '28', formula: null, unit: 'count', validFrom: '2026-01-01', validTo: '2026-12-31', norm: 'НК РФ, ст. 174, 287, 346.21', note: 'День месяца срока уплаты. Проверить с бухгалтером' },
  { key: 'rate_window', value: null, formula: null, unit: 'text', validFrom: '2026-01-01', validTo: '2026-12-31', norm: null, note: '11,12' },
  { key: 'group_unity_signs', value: null, formula: null, unit: 'text', validFrom: '2026-01-01', validTo: null, norm: null, note: 'один бренд, один сайт, общий парк' },
  { key: 'limit_5', value: null, formula: '250000000 * deflator', unit: 'rub', validFrom: '2027-01-01', validTo: null, norm: null, note: 'Дефлятор на 2027 год не утверждён' },
  { key: 'limit_7', value: null, formula: '450000000 * deflator', unit: 'rub', validFrom: '2027-01-01', validTo: null, norm: null, note: 'Дефлятор на 2027 год не утверждён' },
];

/**
 * Единый демо-источник: условная выгрузка из 1С. Дата загрузки 10 октября 2026, 18:00 по часовому
 * поясу приложения (APP_TZ). Факт в выгрузке по сентябрь 2026 включительно, дальше прогноз.
 */
export const SEED_SOURCE = {
  id: 'demo-1c',
  kind: 'demo_1c',
  title: 'Выгрузка из 1С',
  isDemo: true,
  loadedAt: { year: 2026, month: 10, day: 10, hour: 18, minute: 0 },
} as const;

/** Последний месяц с фактом в выгрузке, включительно. */
export const SEED_FACT_THROUGH = { year: 2026, month: 9 } as const;

/** Помесячная структура выручки 2025 года (факт прошлого года, чуть иная, чем прогноз 2026). */
export const SEED_WEIGHTS_2025 = ['.06', '.07', '.08', '.05', '.06', '.08', '.12', '.15', '.11', '.06', '.05', '.11'].map(dec);

/** Выручка 2025 года с НДС по юрлицам, факт. Данные выдуманы. */
export const SEED_ANNUAL_2025: Record<string, Dec> = {
  alfa: dec(25_100_000),
  beta: dec(19_800_000),
  delta: dec(17_600_000),
  gamma: dec(5_700_000),
  epsilon: dec(66_500_000),
};

export interface SeedRevenueRow {
  entityId: string;
  year: number;
  /** 1..12 */
  month: number;
  amount: Dec;
  isFact: boolean;
}

/**
 * Помесячная выручка пяти юрлиц за 2025 и 2026 годы. Детерминирована: не зависит от часов.
 *  2025: все двенадцать месяцев факт;
 *  2026: факт по сентябрь включительно, октябрь идёт (в базе прогноз месяца, признак факта выключен),
 *        ноябрь и декабрь прогноз. Прогноз месяца: годовой прогноз юрлица × вес сезонности.
 */
export function seedRevenueRows(): SeedRevenueRow[] {
  const rows: SeedRevenueRow[] = [];
  for (const e of SEED_ENTITIES) {
    const prev = SEED_ANNUAL_2025[e.id]!;
    SEED_WEIGHTS_2025.forEach((w, i) => {
      rows.push({ entityId: e.id, year: 2025, month: i + 1, amount: round2(prev.times(w)), isFact: true });
    });
    SEED_WEIGHTS.forEach((w, i) => {
      rows.push({
        entityId: e.id,
        year: SEED_FACT_THROUGH.year,
        month: i + 1,
        amount: round2(e.annualRevenue.times(w)),
        isFact: i + 1 <= SEED_FACT_THROUGH.month,
      });
    });
  }
  return rows;
}

export function seedCtx(now: Moment, rows: RuleRow[] = SEED_RULE_ROWS): CalcCtx {
  return { weights: SEED_WEIGHTS, rules: buildRuleSet(rows, now) };
}

export function seedInput(now: Moment, selections: Selections = {}): DashboardInput {
  return { entities: SEED_ENTITIES, selections, ctx: seedCtx(now) };
}
