import { ENTITY_COLORS } from '@/lib/theme';
import { dec } from './decimal';
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
  },
  {
    id: 'beta', name: 'ИП Бета', form: 'ИП', ownerLabel: 'Собственник 1', status: 'payer',
    annualRevenue: dec(22_000_000), inputVatShare: dec('0.34'), color: ENTITY_COLORS.beta!,
    description: 'Аренда без экипажа: комфорт и внедорожники',
    taxRegime: 'usn_income_expense', usnRate: dec('0.15'), annualExpenses: dec(15_400_000),
  },
  {
    id: 'delta', name: 'ИП Дельта', form: 'ИП', ownerLabel: 'Собственник 2', status: 'exempt',
    annualRevenue: dec(20_900_000), inputVatShare: dec('0.18'), color: ENTITY_COLORS.delta!,
    description: 'Аренда без экипажа: комфорт',
    taxRegime: 'usn_income', usnRate: dec('0.06'), annualExpenses: dec(0),
  },
  {
    id: 'gamma', name: 'ООО «Гамма»', form: 'ООО', ownerLabel: 'Собственник 2', status: 'exempt',
    annualRevenue: dec(6_400_000), inputVatShare: dec('0.80'), color: ENTITY_COLORS.gamma!,
    description: 'Аренда с экипажем и трансферы',
    taxRegime: 'usn_income_expense', usnRate: dec('0.15'), annualExpenses: dec(5_200_000),
  },
  {
    id: 'epsilon', name: 'ООО «Эпсилон»', form: 'ООО', ownerLabel: 'Собственник 1', status: 'payer',
    annualRevenue: dec(74_000_000), inputVatShare: dec('0.55'), color: ENTITY_COLORS.epsilon!,
    description: 'Демо: условное юрлицо на ОСНО, данные выдуманы',
    taxRegime: 'osno', usnRate: null, annualExpenses: dec(44_000_000),
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

export function seedCtx(now: Moment, rows: RuleRow[] = SEED_RULE_ROWS): CalcCtx {
  return { weights: SEED_WEIGHTS, rules: buildRuleSet(rows, now) };
}

export function seedInput(now: Moment, selections: Selections = {}): DashboardInput {
  return { entities: SEED_ENTITIES, selections, ctx: seedCtx(now) };
}
