import type { Dec } from './decimal';
import type { CalendarDay } from './time';

export type VatStatus = 'payer' | 'exempt';

/** Система налогообложения юрлица */
export type TaxRegime = 'usn_income' | 'usn_income_expense' | 'osno';

/** Допустимые ставки задаются правилами, но в интерфейсе их ровно три. */
export type Rate = 5 | 7 | 22;
export const RATES: readonly Rate[] = [5, 7, 22];
export const DEFAULT_RATE: Rate = 5;
/** На ОСНО ставка НДС одна: общая, с вычетами. Выбора нет */
export const OSNO_RATE: Rate = 22;

export interface MonthFact {
  /** 0..11 */
  month: number;
  amount: Dec;
  isFact: boolean;
}

export interface EntityInput {
  id: string;
  name: string;
  form: string;
  ownerLabel: string;
  status: VatStatus;
  /** Прогноз выручки года с НДС */
  annualRevenue: Dec;
  /** p: доля закупок с входным НДС от выручки, 0..1 */
  inputVatShare: Dec;
  color: string;
  description: string;
  /** Система налогообложения. Для osno ставка НДС одна: общая 22% с вычетами */
  taxRegime: TaxRegime;
  /** Ставка УСН долей; null: из справочника rules по режиму */
  usnRate: Dec | null;
  /** Расходы за год без НДС */
  annualExpenses: Dec;
  monthly?: MonthFact[];
}

export interface RuleSet {
  /** Дата, на которую собраны правила, YYYY-MM-DD */
  asOf: string;
  year: number;
  vatExemptLimit: Dec;
  /** null: правило есть, но число ещё не утверждено (дефлятор) */
  limit5: Dec | null;
  limit7: Dec | null;
  rates: Rate[];
  generalRate: number;
  twelveQuarters: number;
  /** Окно выбора ставки: номера месяцев 1..12 */
  rateWindowMonths: number[];
  nextYear: {
    year: number;
    deflatorKnown: boolean;
    /** Базовые лимиты из формулы (250 и 450 млн) для текста предупреждения */
    base5: Dec | null;
    base7: Dec | null;
  };
  /** Текст признаков единого бизнеса из справочника, null если не задан */
  groupSigns: string | null;
  /** Налог на прибыль, доля: 0.25 */
  profitTaxRate: Dec;
  /** УСН «доходы», доля: 0.06 */
  usnRateIncome: Dec;
  /** УСН «доходы минус расходы», доля: 0.15 */
  usnRateIncomeExpense: Dec;
  /** Минимальный налог УСН от доходов, доля: 0.01 */
  usnMinTaxRate: Dec;
  /** День месяца срока уплаты: 28 */
  paymentDay: number;
}

export interface CalcCtx {
  /** 12 весов сезонности, сумма равна 1 */
  weights: Dec[];
  rules: RuleSet;
}

export type Selections = Record<string, number>;

export interface DashboardInput {
  entities: EntityInput[];
  selections: Selections;
  ctx: CalcCtx;
}

export type WarningLevel = 'crit' | 'warn' | 'info';

export interface Warning {
  level: WarningLevel;
  kind: string;
  title: string;
  text: string;
  tag: 'Срочно' | 'Внимание' | 'К сведению';
  entityId?: string;
}

export interface EntitySnapshot {
  id: string;
  selected: number;
  best: number;
  ytd: Dec;
  /** налог с начала года по каждой ставке (по накопленной выручке) */
  accrued: Record<number, Dec>;
  /** налог до конца года по каждой ставке (по налогооблагаемой выручке) */
  forecast: Record<number, Dec>;
  /** налог на всю годовую выручку по каждой ставке (для освобождённых это «при переходе порога») */
  fullYear: Record<number, Dec>;
  baseRev: Dec;
  crossing: CalendarDay | null;
}
