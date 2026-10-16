import { baseRev, crossing, monthAmount, selectedRate, taxFor } from './calc';
import { ZERO, dec, round2, sum, type Dec } from './decimal';
import { dateRu, mln, rub } from './format';
import { REGIME_LABEL, incomeTax, yearTotal, type IncomeTaxResult } from './income-tax';
import {
  MONTH_NAMES,
  formatPeriodIn,
  monthKey,
  periodKindOf,
  resolvePeriod,
  type MonthStatus,
  type Period,
  type PeriodKind,
  type ResolvedMonth,
  type ResolvedPeriod,
} from './period';
import {
  StepLog,
  lit,
  moneyText,
  numText,
  ruleRef,
  verifySteps,
  VERIFY_TOLERANCE,
  type FormulaStep,
  type RuleRef,
  type SourceRef,
} from './provenance';
import { MissingRuleError, buildRuleSet, resolveRule, type RuleRow } from './rules';
import { toIsoDate, type CalendarDay, type Moment } from './time';
import {
  OSNO_RATE,
  RATES,
  type CalcCtx,
  type DashboardInput,
  type EntityInput,
  type Rate,
  type RuleSet,
  type Selections,
  type TaxRegime,
  type VatStatus,
  type WarningLevel,
  type WhatIfLabel,
} from './types';

/**
 * Расчётный сервис. Единственное место, где число превращается в «налог за период» с происхождением.
 * Чистые функции над снимком данных (CalcData): база и интерфейс сюда не заходят, снимок собирает
 * lib/db/queries.ts из таблиц. Формулы не переписаны: НДС берётся из taxFor, УСН и налог на прибыль
 * из incomeTax, накопление и порог из calc.ts. Здесь только разбивка по месяцам и описание шагов.
 *
 * Округление. Суммы по месяцам хранятся точно (Decimal, 40 знаков). Налог и выручка юрлица за
 * период округляются до копеек один раз, итог по группе складывается из округлённых значений
 * юрлиц. Так же считает дашборд (groupTotal), поэтому цифры в чате, документах и на дашборде
 * совпадают до копейки.
 */

export type TaxKind = 'vat' | 'usn' | 'profit';

export const TAX_LABEL: Record<TaxKind, string> = {
  vat: 'НДС',
  usn: 'Налог по УСН',
  profit: 'Налог на прибыль',
};

/** Название налога в середине фразы. */
const TAX_WORD: Record<TaxKind, string> = {
  vat: 'НДС',
  usn: 'налог по УСН',
  profit: 'налог на прибыль',
};

/** Строка помесячной выручки из таблицы revenue_monthly. */
export interface RevenueRow {
  entityId: string;
  year: number;
  /** 1..12 */
  month: number;
  amount: Dec;
  isFact: boolean;
  sourceId: string | null;
  updatedAt: string | null;
}

/** Снимок данных для расчёта. Все цифры в нём пришли из таблиц базы. */
export interface CalcData {
  /** Момент, на который считаем («сегодня»), в поясе приложения */
  today: Moment;
  /** Юрлица; monthly содержит строки года `today` для функций калькулятора */
  entities: EntityInput[];
  /** 12 весов сезонности */
  weights: Dec[];
  ruleRows: RuleRow[];
  /** Выбранные ставки НДС по годам: choices[2026][entityId] */
  choices: Record<number, Selections>;
  /** Помесячная выручка всех лет */
  revenue: RevenueRow[];
  source: SourceRef | null;
}

export interface CalcDataInput {
  today: Moment;
  entities: Omit<EntityInput, 'monthly'>[];
  weights: Dec[];
  ruleRows: RuleRow[];
  choices: Record<number, Selections>;
  revenue: RevenueRow[];
  source: SourceRef | null;
}

/** Собирает снимок: проверяет веса и раскладывает строки года `today` по юрлицам для калькулятора. */
export function buildCalcData(input: CalcDataInput): CalcData {
  if (input.weights.length !== 12) {
    throw new Error('Справочник seasonality должен содержать 12 месяцев');
  }
  const total = input.weights.reduce((a, b) => a.plus(b), ZERO);
  if (total.minus(1).abs().gt('0.0001')) {
    throw new Error(`Сумма весов сезонности ${total.toString()}, ожидается 1`);
  }
  const entities: EntityInput[] = input.entities.map((e) => ({
    ...e,
    monthly: input.revenue
      .filter((r) => r.entityId === e.id && r.year === input.today.year)
      .map((r) => ({ month: r.month - 1, amount: r.amount, isFact: r.isFact })),
  }));
  return { ...input, entities };
}

/** Вход дашборда из снимка. Бросает MissingRuleError, если на сегодня нет правил. */
export function dashboardInput(data: CalcData): DashboardInput {
  const rules = buildRuleSet(data.ruleRows, data.today);
  return {
    entities: data.entities,
    selections: data.choices[data.today.year] ?? {},
    ctx: { weights: data.weights, rules },
  };
}

// ===== Результат =====

export type CalcWarningKind =
  | 'exempt'
  | 'threshold'
  | 'no_rules'
  | 'no_data'
  | 'no_fact'
  | 'not_applicable'
  | 'rate_fixed';

export interface CalcWarning {
  kind: CalcWarningKind;
  level: WarningLevel;
  text: string;
  entityId: string | null;
}

export interface MonthResult {
  year: number;
  /** 1..12 */
  month: number;
  /** 2026-03 */
  key: string;
  /** «март 2026» */
  label: string;
  /** Признак с поправкой на данные: прошедший месяц без факта в источнике считается прогнозом */
  status: MonthStatus;
  /** Доля месяца, вошедшая в период */
  coverage: Dec;
  /** Основа выручки: факт из источника или прогноз; null, если данных нет */
  basis: 'fact' | 'forecast' | null;
  /** Выручка с НДС за долю месяца в периоде; null, если данных нет */
  revenue: Dec | null;
  /** Налог за месяц; null, если посчитать нельзя (нет правил на год или нет данных) */
  tax: Dec | null;
  /** Месяц освобождён от НДС */
  exempt: boolean;
  /** Источник факта и время обновления строки; для прогноза null */
  sourceId: string | null;
  updatedAt: string | null;
  revenueStep: string | null;
  taxStep: string | null;
}

export interface EntityResult {
  entityId: string;
  name: string;
  regime: TaxRegime;
  vatStatus: VatStatus;
  /** false: этот налог для режима юрлица не считается, оно не входит в итог */
  applicable: boolean;
  /** Ставка НДС юрлица в расчёте, процент; null, если юрлицо не участвует */
  rate: number | null;
  /** Выручка с НДС за период, округлена до копеек */
  revenue: Dec | null;
  /** Налог за период, округлён до копеек; null, если посчитать нельзя */
  tax: Dec | null;
  kind: PeriodKind;
  months: MonthResult[];
  revenueStep: string | null;
  taxStep: string | null;
}

export interface GroupMonthResult {
  key: string;
  label: string;
  status: MonthStatus;
  coverage: Dec;
  revenue: Dec | null;
  tax: Dec | null;
}

export interface CalcResult {
  tax: TaxKind;
  taxName: string;
  period: Period;
  /** «февраль 2026» */
  periodLabel: string;
  /** Границы периода, включительно */
  from: string;
  to: string;
  /** Единая ставка НДС по участвующим юрлицам; null, если ставки разные */
  rate: number | null;
  /** Итог по группе: сумма округлённых налогов юрлиц; null, если посчитать нельзя */
  total: Dec | null;
  /** Выручка с НДС по участвующим юрлицам; null, если по какому-то из них данных нет */
  revenue: Dec | null;
  entities: EntityResult[];
  months: GroupMonthResult[];
  /** Формулы по шагам, в порядке вычисления */
  steps: FormulaStep[];
  totalStep: string | null;
  revenueStep: string | null;
  /** Применённые правила */
  rules: RuleRef[];
  source: SourceRef | null;
  /** Дата расчёта, YYYY-MM-DD */
  asOf: string;
  kind: PeriodKind;
  warnings: CalcWarning[];
  /** Допущения расчёта: что принято, потому что точных данных нет. Пусто у расчёта по данным */
  assumptions: string[];
  /** Сценарий, по которому посчитано; null у расчёта по данным */
  scenario: ScenarioInfo | null;
  /**
   * Пометка расчёта в сценарии «что если» (lib/calc/whatif.ts): «сейчас» или «по сценарию». Её
   * ставит модуль сценария, calcTax поля не заполняет.
   */
  whatIf?: WhatIfLabel | null;
}

/**
 * Сценарий прогноза следующего года, которого нет в данных. Выручка каждого юрлица берётся как
 * годовая выручка текущего года с коэффициентом роста и раскладывается по месяцам по сезонности;
 * правила следующего года принимаются как правила текущего, пока они не утверждены (лимиты 5% и 7%
 * зависят от дефлятора). Формулы и пороги те же, что у расчёта по данным.
 */
export interface ForecastScenario {
  kind: 'forecast';
  /** Год сценария: следующий за годом «сегодня» */
  year: number;
  /** Рост выручки к текущему году, проценты: 0 как в текущем году, 10 это +10%, отрицательное это спад */
  growth: number;
}

/** Сценарий в результате расчёта: заданный и что из него вышло. */
export interface ScenarioInfo extends ForecastScenario {
  /** Лимиты ставок 5% и 7% на год сценария утверждены в справочнике; false: приняты как в текущем году */
  limitsApproved: boolean;
}

/** Границы роста в сценарии: защита от опечатки в запросе, не бизнес-правило. */
export const SCENARIO_GROWTH_MIN = -90;
export const SCENARIO_GROWTH_MAX = 500;

export interface CalcTaxArgs {
  entityIds: string[] | 'all';
  tax: TaxKind;
  period: Period;
  /** Ставка НДС для расчёта вместо выбранной; на ОСНО ставка всегда 22% */
  rate?: Rate;
  /** Прогноз следующего года: выручка текущего года с ростом, правила как в текущем году */
  scenario?: ForecastScenario;
}

export class CalcInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalcInputError';
  }
}

// ===== Внутренности =====

const LEVEL_ORDER: Record<WarningLevel, number> = { crit: 0, warn: 1, info: 2 };

const RATE_KEY: Record<number, string> = {
  5: 'rate_special_5',
  7: 'rate_special_7',
  22: 'rate_general',
};

const monthLabel = (year: number, month: number): string => `${MONTH_NAMES[month - 1]} ${year}`;

function isApplicable(tax: TaxKind, e: EntityInput): boolean {
  if (tax === 'vat') return true;
  return tax === 'profit' ? e.taxRegime === 'osno' : e.taxRegime !== 'osno';
}

function rowKey(entityId: string, year: number, month: number): string {
  return `${entityId}|${monthKey(year, month)}`;
}

interface YearRules {
  ctx: CalcCtx;
  /** Дата, на которую взяты правила, YYYY-MM-DD */
  date: string;
}

interface MonthBasis {
  rm: ResolvedMonth;
  /** Выручка полного месяца с НДС; null, если данных нет */
  full: Dec | null;
  basis: 'fact' | 'forecast' | null;
  row: RevenueRow | null;
  /** Месяц прошёл, но факта в источнике нет */
  missingFact: boolean;
  status: MonthStatus;
}

/** Подготовленный сценарий прогноза: данные базового года, по которым строится следующий. */
interface ScenarioRun {
  spec: ForecastScenario;
  baseYear: number;
  /** 1 + рост / 100 */
  factor: Dec;
  /** Выручка базового года с НДС по юрлицам: факт прошедших месяцев и прогноз остальных */
  base: Map<string, Dec>;
  /** Дата пересечения порога освобождения в базовом году (тот же модуль, что на дашборде) */
  baseCrossing: Map<string, CalendarDay | null>;
  /** Правила базового года */
  baseRules: RuleSet;
  /** Лимиты 5% и 7% следующего года утверждены в справочнике, а не приняты как в базовом году */
  limitsApproved: boolean;
}

/** Всё, что нужно, чтобы определить выручку месяца. */
interface BasisCtx {
  data: CalcData;
  today: Moment;
  rows: Map<string, RevenueRow>;
  scenario: ScenarioRun | null;
}

interface Run extends BasisCtx {
  args: CalcTaxArgs;
  resolved: ResolvedPeriod;
  log: StepLog;
  warnings: CalcWarning[];
  years: Map<number, YearRules | null>;
  ruleRefs: Map<string, RuleRef>;
  /** Освобождённые: с какого месяца (0..11) облагаются, по юрлицу и году */
  exemptFrom: Map<string, ExemptInfo>;
}

interface ExemptInfo {
  /** Индекс первого облагаемого месяца 0..11; Infinity: в этом году не облагается; null: неизвестно */
  from: number | null;
  crossing: CalendarDay | null;
  /** Сценарий: порог пройден в базовом году, юрлицо платит НДС весь год сценария */
  fromPriorYear?: boolean;
}

export function pickEntities(ids: string[] | 'all', data: CalcData): EntityInput[] {
  if (ids === 'all') return data.entities;
  if (ids.length === 0) throw new CalcInputError('Не выбрано ни одного юрлица');
  const known = new Set(data.entities.map((e) => e.id));
  for (const id of ids) {
    if (!known.has(id)) throw new CalcInputError(`Юрлицо не найдено: ${id}`);
  }
  const want = new Set(ids);
  return data.entities.filter((e) => want.has(e.id));
}

/** Правила на год периода. Дата: «сегодня», сжатая в границы части периода внутри этого года. */
function yearRules(data: CalcData, resolved: ResolvedPeriod, year: number): YearRules | null {
  const inYear = resolved.months.filter((m) => m.year === year);
  if (inYear.length === 0) return null;
  const first = inYear[0]!.from;
  const last = inYear[inYear.length - 1]!.to;
  const todayIso = toIsoDate({ year: data.today.year, month: data.today.month, day: data.today.day });
  const date = todayIso < first ? first : todayIso > last ? last : todayIso;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at: Moment = {
    year: y,
    month: m - 1,
    day: d,
    secondsOfDay: date === todayIso ? data.today.secondsOfDay : 0,
  };
  try {
    return { ctx: { weights: data.weights, rules: buildRuleSet(data.ruleRows, at) }, date };
  } catch (e) {
    if (e instanceof MissingRuleError) return null;
    throw e;
  }
}

function addRule(run: Run, year: number, key: string): void {
  const yr = run.years.get(year);
  if (!yr) return;
  const row = resolveRule(run.data.ruleRows, key, yr.date);
  if (row) run.ruleRefs.set(`${row.key}|${row.validFrom}`, ruleRef(row));
}

function warn(run: Run, w: CalcWarning): void {
  run.warnings.push(w);
}

/** Выручка полного месяца: факт (если месяц прошёл и в источнике есть факт) или прогноз года на вес месяца. */
function monthBasis(ctx: BasisCtx, e: EntityInput, rm: ResolvedMonth): MonthBasis {
  const { data, today } = ctx;
  const sc = ctx.scenario;
  if (sc && rm.year === sc.spec.year) {
    // сценарий: выручка базового года с ростом по сезонности, фактов у следующего года нет
    const full = sc.base.get(e.id)!.times(sc.factor).times(data.weights[rm.month - 1]!);
    return { rm, full, basis: 'forecast', row: null, missingFact: false, status: 'forecast' };
  }
  const row = ctx.rows.get(rowKey(e.id, rm.year, rm.month)) ?? null;
  const past = rm.status === 'fact';
  if (rm.year === today.year) {
    // та же функция, что считает накопление на дашборде
    const full = monthAmount(e, { weights: data.weights }, rm.month - 1, today);
    const isFact = past && row?.isFact === true;
    const missing = past && !isFact;
    return {
      rm,
      full,
      basis: isFact ? 'fact' : 'forecast',
      row: isFact ? row : null,
      missingFact: missing,
      status: missing ? 'forecast' : rm.status,
    };
  }
  if (past && row?.isFact) {
    return { rm, full: row.amount, basis: 'fact', row, missingFact: false, status: 'fact' };
  }
  return { rm, full: null, basis: null, row: null, missingFact: past, status: past ? 'forecast' : rm.status };
}

/** Помесячные основы для всех 12 месяцев года (нужны для порога вне периода). */
function wholeYearBasis(ctx: BasisCtx, e: EntityInput, year: number): MonthBasis[] {
  return resolvePeriod({ kind: 'year', year }, ctx.today).months.map((rm) => monthBasis(ctx, e, rm));
}

/**
 * С какого месяца года освобождённое юрлицо платит НДС. Для года «сегодня» это та же дата
 * пересечения порога, что на дашборде (crossing), для остальных лет порог ищется по фактам.
 */
function exemptInfo(run: Run, e: EntityInput, year: number): ExemptInfo {
  const cacheKey = `${e.id}|${year}`;
  const hit = run.exemptFrom.get(cacheKey);
  if (hit) return hit;
  const yr = run.years.get(year);
  let info: ExemptInfo;
  if (!yr) {
    info = { from: null, crossing: null };
  } else if (year === run.today.year) {
    const c = crossing(e, yr.ctx, run.today);
    info = { from: c ? c.month + 1 : Infinity, crossing: c };
  } else {
    // сценарий: порог пройден в базовом году, значит юрлицо стало плательщиком и платит весь год
    const prior = run.scenario && year === run.scenario.spec.year ? (run.scenario.baseCrossing.get(e.id) ?? null) : null;
    if (prior) {
      info = { from: 0, crossing: prior, fromPriorYear: true };
    } else {
      const limit = yr.ctx.rules.vatExemptLimit;
      let cum = ZERO;
      info = { from: Infinity, crossing: null };
      for (const b of wholeYearBasis(run, e, year)) {
        if (b.full === null) {
          info = { from: null, crossing: null };
          break;
        }
        cum = cum.plus(b.full);
        if (cum.gte(limit)) {
          info = { from: b.rm.month, crossing: { year, month: b.rm.month - 1, day: b.rm.daysInMonth } };
          break;
        }
      }
    }
  }
  run.exemptFrom.set(cacheKey, info);
  return info;
}

/** Ставка НДС юрлица в расчёте: заданная, иначе выбранная, на ОСНО всегда общая. */
function vatRate(run: Run, e: EntityInput, year: number): number {
  if (e.taxRegime === 'osno') return OSNO_RATE;
  if (run.args.rate !== undefined) return run.args.rate;
  // у года сценария выбора нет: берётся ставка, выбранная в базовом году
  const chosenYear = run.scenario && year === run.scenario.spec.year ? run.scenario.baseYear : year;
  return selectedRate(e, run.data.choices[chosenYear] ?? {});
}

/** Шаг выручки месяца: факт или прогноз, с долей месяца, если период захватывает его частично. */
function revenueStep(run: Run, e: EntityInput, b: MonthBasis): FormulaStep {
  const { rm } = b;
  const partial = !rm.coverage.eq(1);
  const part = partial ? ` × ${numText(rm.coveredDays)} / ${rm.daysInMonth}` : '';
  const partExpr = partial ? ` * ${lit(rm.coveredDays)} / ${rm.daysInMonth}` : '';
  const result = b.full!.times(rm.coverage);
  const label = `${e.name}, ${monthLabel(rm.year, rm.month)}`;
  if (b.basis === 'fact') {
    const base = moneyText(b.full!);
    return run.log.add({
      label,
      text: partial
        ? `выручка по факту ${base}${part} = ${moneyText(result)}`
        : `выручка по факту ${base}`,
      expression: `${lit(b.full!)}${partExpr}`,
      result,
      entityId: e.id,
      month: rm.key,
    });
  }
  const w = run.data.weights[rm.month - 1]!;
  const sc = run.scenario;
  // сценарий «что если»: выручка идущего и будущих месяцев это прогноз месяца × рост + добавка
  const whatIf = rm.year === run.today.year && rm.month - 1 >= run.today.month ? e.whatIf?.parts[rm.month - 1] : undefined;
  if (whatIf) {
    const grown = whatIf.factor.eq(1) ? '' : ` × ${numText(whatIf.factor)}`;
    const added = whatIf.extra.isZero()
      ? ''
      : whatIf.extra.gt(0)
        ? ` + добавочная выручка ${moneyText(whatIf.extra)}`
        : ` − снижение ${moneyText(whatIf.extra.abs())}`;
    const parts = grown === '' && added === '' ? ', без изменений' : '';
    const expr = `${lit(whatIf.base)} * ${lit(whatIf.factor)} ${whatIf.extra.isNegative() ? '-' : '+'} ${lit(whatIf.extra.abs())}`;
    return run.log.add({
      label,
      text:
        `по сценарию: прогноз месяца ${moneyText(whatIf.base)}${grown}${added}${parts}${part}` +
        ` = ${moneyText(result)}`,
      expression: partial ? `(${expr})${partExpr}` : expr,
      result,
      entityId: e.id,
      month: rm.key,
    });
  }
  if (sc && rm.year === sc.spec.year) {
    const base = sc.base.get(e.id)!;
    const grown = sc.spec.growth === 0 ? '' : ` × ${numText(sc.factor)} (рост ${numText(sc.spec.growth)}%)`;
    return run.log.add({
      label,
      text:
        `прогноз ${rm.year}: выручка ${sc.baseYear} года ${moneyText(base)}${grown} × доля месяца ${numText(w)}${part}` +
        ` = ${moneyText(result)}`,
      expression: `${lit(base)} * ${lit(sc.factor)} * ${lit(w)}${partExpr}`,
      result,
      entityId: e.id,
      month: rm.key,
    });
  }
  return run.log.add({
    label,
    text:
      `прогноз выручки года ${moneyText(e.annualRevenue)} × доля месяца ${numText(w)}${part}` +
      ` = ${moneyText(result)}`,
    expression: `${lit(e.annualRevenue)} * ${lit(w)}${partExpr}`,
    result,
    entityId: e.id,
    month: rm.key,
  });
}

function sumStep(
  run: Run,
  args: {
    label: string;
    text: string;
    ids: string[];
    round: boolean;
    entityId: string | null;
    result: Dec;
  },
): FormulaStep {
  const inner = args.ids.length === 0 ? '0' : args.ids.join(' + ');
  return run.log.add({
    label: args.label,
    text: args.text,
    expression: args.round ? `round2(${inner})` : inner,
    result: args.result,
    entityId: args.entityId,
    month: null,
  });
}

interface EntityMonthDraft {
  basis: MonthBasis;
  revenue: Dec | null;
  revenueStep: FormulaStep | null;
  tax: Dec | null;
  taxStep: FormulaStep | null;
  exempt: boolean;
}

function calcVatMonths(run: Run, e: EntityInput, rate: number, drafts: EntityMonthDraft[]): void {
  for (const d of drafts) {
    const { rm } = d.basis;
    const yr = run.years.get(rm.year);
    if (!yr || d.revenue === null) continue;
    const label = `${e.name}, ${monthLabel(rm.year, rm.month)}`;
    let taxable = true;
    if (e.status === 'exempt') {
      const info = exemptInfo(run, e, rm.year);
      if (info.from === null) continue;
      taxable = rm.month - 1 >= info.from;
    }
    if (!taxable) {
      d.exempt = true;
      d.tax = ZERO;
      d.taxStep = run.log.add({
        label,
        text: `освобождено от НДС (порог ${rub(yr.ctx.rules.vatExemptLimit)}), налог 0 ₽`,
        expression: '0',
        result: ZERO,
        entityId: e.id,
        month: rm.key,
      });
      continue;
    }
    const g = yr.ctx.rules.generalRate;
    const deduction = rate === g;
    const p = e.inputVatShare;
    // сценарий «машины»: входной НДС по купленным машинам вычитается в месяце начала сдачи. Только
    // при ставке с вычетами; сценарий выставляет поле лишь тем, у кого вычет есть
    const cars =
      deduction && rm.year === run.today.year && rm.month - 1 >= run.today.month
        ? e.whatIf?.parts[rm.month - 1]?.vatDeduct
        : undefined;
    const regular = taxFor(rate, d.revenue, e.inputVatShare, g);
    const tax = cars ? regular.minus(cars) : regular;
    const head = `НДС ${rate}%: выручка ${moneyText(d.revenue)} × ${rate} / ${100 + rate}`;
    const tail = `где ${numText(p)} это доля закупок с входным НДС`;
    d.tax = tax;
    d.taxStep = run.log.add({
      label,
      text: cars
        ? `${head} × (1 - ${numText(p)}) - входной НДС по машинам ${moneyText(cars)} = ${moneyText(tax)}, ${tail}`
        : deduction
          ? `${head} × (1 - ${numText(p)}) = ${moneyText(tax)}, ${tail}`
          : `${head} = ${moneyText(tax)}`,
      expression:
        `${d.revenueStep!.id} * ${rate} / ${100 + rate}${deduction ? ` * (1 - ${lit(p)})` : ''}` +
        (cars ? ` - ${lit(cars)}` : ''),
      result: tax,
      entityId: e.id,
      month: rm.key,
    });
  }
}

function calcIncomeTaxMonths(run: Run, e: EntityInput, rate: number, drafts: EntityMonthDraft[]): void {
  const { today } = run;
  const year = today.year;
  const yr = run.years.get(year);
  if (!yr) return;
  const touched = drafts.some((d) => d.basis.rm.year === year && d.revenue !== null);
  if (!touched) return;

  const selections: Selections = { ...(run.data.choices[year] ?? {}) };
  if (e.taxRegime !== 'osno') selections[e.id] = rate;

  const tx: IncomeTaxResult = incomeTax(e, yr.ctx, selections, today);
  const taxWord = e.taxRegime === 'osno' ? TAX_WORD.profit : TAX_WORD.usn;
  const total = yearTotal(e, yr.ctx, today);
  const base = baseRev(e, yr.ctx, today);
  const log = run.log;
  const label = `${e.name}, расчёт за ${year} год`;
  const common = { label, entityId: e.id, month: null } as const;

  // доходы без НДС: выручка года минус НДС в облагаемой части
  const incomeStep = log.add({
    ...common,
    text:
      `доходы без НДС: ${moneyText(e.annualRevenue)} - ${moneyText(base)} × ${rate} / ${100 + rate} = ` +
      moneyText(tx.income),
    expression: `${lit(e.annualRevenue)} - ${lit(base)} * ${rate} / ${100 + rate}`,
    result: tx.income,
  });

  let baseId = incomeStep.id;
  if (e.taxRegime !== 'usn_income') {
    const what = e.taxRegime === 'osno' ? 'прибыль' : 'доходы минус расходы';
    baseId = log.add({
      ...common,
      text:
        `база, ${what}: ${moneyText(tx.income)} - расходы ${moneyText(tx.expenses)} = ${moneyText(tx.base)}` +
        ' (не меньше нуля)',
      expression: `max(0, ${incomeStep.id} - ${lit(tx.expenses)})`,
      result: tx.base,
    }).id;
  }

  const ratePart = lit(tx.ratePct.div(100));
  const calcStep = log.add({
    ...common,
    text: `${taxWord} за год: база ${moneyText(tx.base)} × ${numText(tx.ratePct)}% = ${moneyText(tx.calculated)}`,
    expression: `${baseId} * ${ratePart}`,
    result: tx.calculated,
  });

  let yearTaxId = calcStep.id;
  if (e.taxRegime === 'usn_income_expense') {
    const minStep = log.add({
      ...common,
      text: `минимальный налог: доходы ${moneyText(tx.income)} × ${numText(yr.ctx.rules.usnMinTaxRate.times(100))}% = ${moneyText(tx.minimum)}`,
      expression: `${incomeStep.id} * ${lit(yr.ctx.rules.usnMinTaxRate)}`,
      result: tx.minimum,
    });
    yearTaxId = log.add({
      ...common,
      text:
        `налог за год: большее из ${moneyText(tx.calculated)} и ${moneyText(tx.minimum)} = ` +
        moneyText(tx.forecast),
      expression: `max(${calcStep.id}, ${minStep.id})`,
      result: tx.forecast,
    }).id;
  }

  // выручка года по месяцам: факт прошедших месяцев и прогноз остальных
  const monthly: Dec[] = [];
  for (let m = 0; m < 12; m++) monthly.push(monthAmount(e, { weights: run.data.weights }, m, today));
  const totalStep = log.add({
    ...common,
    text: `выручка года с НДС, факт прошедших месяцев и прогноз остальных: ${moneyText(total)}`,
    expression: monthly.map((v) => lit(v)).join(' + '),
    result: total,
  });

  for (const d of drafts) {
    const { rm } = d.basis;
    if (rm.year !== year || d.revenue === null) continue;
    const share = total.isZero() ? ZERO : d.revenue.div(total);
    const tax = tx.forecast.times(share);
    d.tax = tax;
    d.taxStep = log.add({
      label: `${e.name}, ${monthLabel(rm.year, rm.month)}`,
      text:
        `доля налога года: ${moneyText(tx.forecast)} × выручка ${moneyText(d.revenue)} / выручка года ` +
        `${moneyText(total)} = ${moneyText(tax)}`,
      expression: `${yearTaxId} * ${d.revenueStep!.id} / ${totalStep.id}`,
      result: tax,
      entityId: e.id,
      month: rm.key,
    });
  }
}

function calcEntity(run: Run, e: EntityInput): EntityResult {
  const { args, resolved } = run;
  const applicable = isApplicable(args.tax, e);
  const base: Pick<EntityResult, 'entityId' | 'name' | 'regime' | 'vatStatus'> = {
    entityId: e.id,
    name: e.name,
    regime: e.taxRegime,
    vatStatus: e.status,
  };

  if (!applicable) {
    warn(run, {
      kind: 'not_applicable',
      level: 'info',
      entityId: e.id,
      text: `${e.name}: ${TAX_WORD[args.tax]} не считается для режима «${REGIME_LABEL[e.taxRegime]}», юрлицо не входит в итог`,
    });
    return {
      ...base,
      applicable: false,
      rate: null,
      revenue: null,
      tax: null,
      kind: periodKindOf(resolved.months.map((m) => m.status)),
      months: [],
      revenueStep: null,
      taxStep: null,
    };
  }

  const years = [...new Set(resolved.months.map((m) => m.year))];
  const rateByYear = new Map(years.map((y) => [y, vatRate(run, e, y)] as const));
  const primaryRate = rateByYear.get(years[0]!)!;

  if (e.taxRegime === 'osno' && args.rate !== undefined && args.rate !== OSNO_RATE) {
    warn(run, {
      kind: 'rate_fixed',
      level: 'info',
      entityId: e.id,
      text: `${e.name} на ОСНО: ставка НДС ${OSNO_RATE}% с вычетами одна, заданная ставка ${args.rate}% не применена`,
    });
  }

  // выручка по месяцам периода
  const drafts: EntityMonthDraft[] = resolved.months.map((rm) => {
    const basis = monthBasis(run, e, rm);
    const d: EntityMonthDraft = {
      basis,
      revenue: null,
      revenueStep: null,
      tax: null,
      taxStep: null,
      exempt: false,
    };
    if (basis.full !== null) {
      d.revenueStep = revenueStep(run, e, basis);
      d.revenue = d.revenueStep.result;
    }
    return d;
  });

  const noData = drafts.filter((d) => d.basis.full === null);
  const noFact = drafts.filter((d) => d.basis.missingFact && d.basis.full !== null);

  if (noData.length > 0) {
    warn(run, {
      kind: 'no_data',
      level: 'warn',
      entityId: e.id,
      text:
        noData.length === drafts.length
          ? `${e.name}: нет данных о выручке за ${resolved.label}`
          : `${e.name}: нет данных о выручке за ${noData.map((d) => monthLabel(d.basis.rm.year, d.basis.rm.month)).join(', ')}`,
    });
  }
  if (noFact.length > 0) {
    warn(run, {
      kind: 'no_fact',
      level: 'warn',
      entityId: e.id,
      text:
        `${e.name}: за ${noFact.map((d) => monthLabel(d.basis.rm.year, d.basis.rm.month)).join(', ')} ` +
        'в источнике нет факта, взят прогноз',
    });
  }

  // правила: что применено
  for (const y of years) {
    if (!run.years.get(y)) continue;
    addRule(run, y, RATE_KEY[rateByYear.get(y)!]!);
    if (e.status === 'exempt') addRule(run, y, 'vat_exempt_limit');
    if (run.scenario && y === run.scenario.spec.year) {
      // лимиты следующего года приняты как в текущем: они в списке правил расчёта
      addRule(run, y, 'limit_5');
      addRule(run, y, 'limit_7');
    }
    if (args.tax === 'usn') {
      if (e.usnRate === null) {
        addRule(run, y, e.taxRegime === 'usn_income_expense' ? 'usn_rate_income_expense' : 'usn_rate_income');
      }
      if (e.taxRegime === 'usn_income_expense') addRule(run, y, 'usn_min_tax_rate');
    }
    if (args.tax === 'profit') addRule(run, y, 'profit_tax_rate');
  }

  // налог
  if (args.tax === 'vat') {
    // выбор ставки хранится по годам, поэтому ставка считается отдельно для каждого года периода
    for (const y of years) {
      calcVatMonths(run, e, rateByYear.get(y)!, drafts.filter((d) => d.basis.rm.year === y));
    }
  } else {
    const otherYears = years.filter((y) => y !== run.today.year && run.years.get(y));
    for (const y of otherYears) {
      warn(run, {
        kind: 'no_data',
        level: 'warn',
        entityId: e.id,
        text: `${e.name}: расходы за ${y} год в базе не заданы, ${TAX_WORD[args.tax]} за ${y} год не рассчитан`,
      });
    }
    // налог года считается за год «сегодня»: ставка НДС берётся этого года
    calcIncomeTaxMonths(run, e, rateByYear.get(run.today.year) ?? primaryRate, drafts);
  }

  // предупреждения по НДС: освобождение и порог
  if (args.tax === 'vat' && e.status === 'exempt') {
    for (const y of years) {
      const yr = run.years.get(y);
      if (!yr) continue;
      const info = exemptInfo(run, e, y);
      const limit = mln(yr.ctx.rules.vatExemptLimit, 0);
      if (info.fromPriorYear && info.crossing) {
        warn(run, {
          kind: 'threshold',
          level: 'warn',
          entityId: e.id,
          text:
            `${e.name}: выручка ${run.scenario!.baseYear} года проходит порог ${limit} около ${dateRu(info.crossing)}, ` +
            `поэтому с 1 января ${y} года НДС платится весь год`,
        });
        continue;
      }
      const exemptMonths = drafts.filter((d) => d.basis.rm.year === y && d.exempt);
      if (exemptMonths.length > 0) {
        warn(run, {
          kind: 'exempt',
          level: 'info',
          entityId: e.id,
          text: `${e.name}: освобождение от НДС, налог за период не начисляется, пока выручка года не достигнет ${limit}`,
        });
      }
      if (info.crossing && info.from !== null && info.from !== Infinity) {
        const c = info.crossing;
        const start =
          info.from > 11
            ? `1 января ${y + 1}`
            : dateRu({ month: info.from, day: 1 });
        const when =
          y === run.today.year
            ? `около ${dateRu(c)}`
            : formatPeriodIn({ kind: 'month', year: y, month: c.month + 1 });
        warn(run, {
          kind: 'threshold',
          level: 'warn',
          entityId: e.id,
          text: `${e.name}: порог ${limit} пересекается ${when}, НДС начнётся с ${start}`,
        });
      }
    }
  }

  // итоги юрлица
  const revenueSteps = drafts.filter((d) => d.revenueStep).map((d) => d.revenueStep!);
  const allRevenue = drafts.every((d) => d.revenue !== null);
  let revenueTotal: Dec | null = null;
  let revenueTotalStep: FormulaStep | null = null;
  if (allRevenue && revenueSteps.length > 0) {
    const raw = sum(revenueSteps.map((s) => s.result));
    revenueTotal = round2(raw);
    revenueTotalStep = sumStep(run, {
      label: `${e.name}, ${resolved.label}`,
      text: `выручка с НДС за период, сумма по месяцам: ${moneyText(revenueTotal)}`,
      ids: revenueSteps.map((s) => s.id),
      round: true,
      entityId: e.id,
      result: revenueTotal,
    });
  } else if (allRevenue) {
    revenueTotal = ZERO;
  }

  const allTax = drafts.length > 0 && drafts.every((d) => d.tax !== null);
  let taxTotal: Dec | null = null;
  let taxTotalStep: FormulaStep | null = null;
  if (allTax) {
    const steps = drafts.map((d) => d.taxStep!);
    taxTotal = round2(sum(steps.map((s) => s.result)));
    taxTotalStep = sumStep(run, {
      label: `${e.name}, ${resolved.label}`,
      text: `${TAX_WORD[args.tax]} за период, сумма по месяцам, округлено до копеек: ${moneyText(taxTotal)}`,
      ids: steps.map((s) => s.id),
      round: true,
      entityId: e.id,
      result: taxTotal,
    });
  } else if (drafts.length === 0) {
    taxTotal = ZERO;
  }

  const months: MonthResult[] = drafts.map((d) => ({
    year: d.basis.rm.year,
    month: d.basis.rm.month,
    key: d.basis.rm.key,
    label: monthLabel(d.basis.rm.year, d.basis.rm.month),
    status: d.basis.status,
    coverage: d.basis.rm.coverage,
    basis: d.basis.basis,
    revenue: d.revenue,
    tax: d.tax,
    exempt: d.exempt,
    sourceId: d.basis.row?.sourceId ?? null,
    updatedAt: d.basis.row?.updatedAt ?? null,
    revenueStep: d.revenueStep?.id ?? null,
    taxStep: d.taxStep?.id ?? null,
  }));

  return {
    ...base,
    applicable: true,
    rate: new Set(rateByYear.values()).size === 1 ? primaryRate : null,
    revenue: revenueTotal,
    tax: taxTotal,
    kind: periodKindOf(months.map((m) => m.status)),
    months,
    revenueStep: revenueTotalStep?.id ?? null,
    taxStep: taxTotalStep?.id ?? null,
  };
}

// ===== Сценарий прогноза следующего года =====

/** Ключи справочника, значение которых зависит от дефлятора: их допущение называется отдельно. */
const DEFLATOR_RULES = new Set(['limit_5', 'limit_7']);

/**
 * Готовит сценарий: выручка базового года по юрлицам, дата пересечения порога в базовом году
 * (тот же модуль crossing, что на дашборде) и справочник, в котором правила следующего года
 * заменены значениями базового. Правило, у которого на следующий год есть утверждённое значение,
 * остаётся как есть.
 */
function prepareScenario(args: CalcTaxArgs, data: CalcData, spec: ForecastScenario): { data: CalcData; scenario: ScenarioRun } {
  const baseYear = data.today.year;
  if (args.tax !== 'vat') {
    throw new CalcInputError('Прогноз следующего года считается только для НДС');
  }
  if (spec.kind !== 'forecast' || spec.year !== baseYear + 1) {
    throw new CalcInputError(`Прогноз считается на ${baseYear + 1} год, запрошен ${String(spec.year)}`);
  }
  if (!Number.isFinite(spec.growth) || spec.growth < SCENARIO_GROWTH_MIN || spec.growth > SCENARIO_GROWTH_MAX) {
    throw new CalcInputError(
      `Рост выручки должен быть от ${SCENARIO_GROWTH_MIN} до ${SCENARIO_GROWTH_MAX} процентов: ${String(spec.growth)}`,
    );
  }

  let baseRules: RuleSet;
  try {
    baseRules = buildRuleSet(data.ruleRows, data.today);
  } catch (e) {
    if (e instanceof MissingRuleError) {
      throw new CalcInputError(`Нет правил на ${baseYear} год: прогноз на ${spec.year} год построить не от чего`);
    }
    throw e;
  }
  const ctx: CalcCtx = { weights: data.weights, rules: baseRules };
  const base = new Map<string, Dec>();
  const baseCrossing = new Map<string, CalendarDay | null>();
  for (const e of data.entities) {
    base.set(e.id, yearTotal(e, ctx, data.today));
    baseCrossing.set(e.id, e.status === 'exempt' ? crossing(e, ctx, data.today) : null);
  }

  const from = `${spec.year}-01-01`;
  const asOf = toIsoDate(data.today);
  const dropped = new Set<RuleRow>();
  const copies: RuleRow[] = [];
  for (const key of new Set(data.ruleRows.map((r) => r.key))) {
    const cur = resolveRule(data.ruleRows, key, asOf);
    if (!cur) continue;
    const next = resolveRule(data.ruleRows, key, from);
    // правило действует и в следующем году, либо на него уже есть утверждённое значение
    if (next && (next.validFrom <= asOf || next.value !== null)) continue;
    if (next) dropped.add(next);
    const why = DEFLATOR_RULES.has(key)
      ? `дефлятор на ${spec.year} год не утверждён`
      : `правила на ${spec.year} год не утверждены`;
    copies.push({
      ...cur,
      validFrom: from,
      validTo: null,
      note: `${cur.note ? `${cur.note}. ` : ''}Принято как в ${baseYear} году: ${why}`,
    });
  }

  return {
    data: { ...data, ruleRows: [...data.ruleRows.filter((r) => !dropped.has(r)), ...copies] },
    scenario: {
      spec,
      baseYear,
      factor: dec(1).plus(dec(spec.growth).div(100)),
      base,
      baseCrossing,
      baseRules,
      limitsApproved: [...DEFLATOR_RULES].every((key) => {
        const next = resolveRule(data.ruleRows, key, from);
        return next !== null && next.value !== null;
      }),
    },
  };
}

/** Допущения сценария одним списком: по ним панель расчёта, Excel и карточка «Понял так». */
function scenarioAssumptions(run: Run, used: EntityResult[]): string[] {
  const sc = run.scenario!;
  const { spec, baseYear } = sc;
  const g = spec.growth;
  const out: string[] = [
    g === 0
      ? `Выручка ${spec.year} года как в ${baseYear}: годовая выручка ${baseYear} года каждого юрлица без роста, по месяцам по сезонности`
      : `Выручка ${spec.year} года: годовая выручка ${baseYear} года каждого юрлица ${g > 0 ? 'с ростом' : 'со снижением'} ${numText(Math.abs(g))}%, по месяцам по сезонности`,
  ];
  const rules = run.years.get(spec.year)?.ctx.rules;
  if (rules) {
    const parts: string[] = [];
    if (rules.limit5) parts.push(`ставка 5% до ${mln(rules.limit5, 1)}`);
    if (rules.limit7) parts.push(`ставка 7% до ${mln(rules.limit7, 1)}`);
    parts.push(`порог освобождения от НДС ${mln(rules.vatExemptLimit, 0)}`);
    out.push(
      sc.limitsApproved
        ? `Лимиты ${spec.year} года по справочнику: ${parts.join(', ')}`
        : `Лимиты ${spec.year} года как в ${baseYear} (дефлятор не утверждён): ${parts.join(', ')}`,
    );
  }
  for (const r of used) {
    const info = run.exemptFrom.get(`${r.entityId}|${spec.year}`);
    if (info?.fromPriorYear && info.crossing) {
      out.push(
        `${r.name}: выручка ${baseYear} года проходит порог освобождения ${mln(sc.baseRules.vatExemptLimit, 0)} ` +
          `около ${dateRu(info.crossing)}, поэтому с 1 января ${spec.year} года платит НДС`,
      );
    }
  }
  return out;
}

/**
 * Допущения сценария одной строкой, для карточки «Понял так»:
 * «Выручка как в 2026, лимиты как в 2026 (дефлятор не утверждён)».
 */
export function scenarioLine(info: ScenarioInfo): string {
  const base = info.year - 1;
  const g = info.growth;
  const revenue =
    g === 0 ? `Выручка как в ${base}` : `Выручка ${base} года ${g > 0 ? '+' : '−'}${numText(Math.abs(g))}%`;
  return info.limitsApproved
    ? `${revenue}, лимиты ${info.year} года по справочнику`
    : `${revenue}, лимиты как в ${base} (дефлятор не утверждён)`;
}

// ===== Сравнение ставок =====

export interface RateRow {
  entityId: string;
  name: string;
  /** Налог за период при ставках 5, 7 и 22 */
  tax: Record<Rate, Dec>;
  /** Юрлицо весь период освобождено от НДС: налог 0 при любой ставке, лучшей ставки нет */
  exemptAll: boolean;
  /** Ставка с наименьшим налогом, при равенстве меньшая; null, если налога нет ни при какой */
  best: Rate | null;
  /** Следующая по выгоде ставка */
  against: Rate | null;
  /** На сколько она дороже лучшей */
  saving: Dec | null;
}

export interface RateComparison {
  period: Period;
  periodLabel: string;
  scenario: ScenarioInfo | null;
  /** Юрлица, у которых есть выбор ставки */
  rows: RateRow[];
  /** Юрлица на ОСНО: ставка одна, 22% с вычетами, выбора нет */
  osno: { entityId: string; name: string; tax: Dec }[];
  /** Итог по столбцу таблицы: налог юрлиц с выбором при одной ставке для всех */
  totals: Record<Rate, Dec>;
  /** Налог группы при лучшей ставке каждого юрлица (юрлица на ОСНО по своей единственной) */
  bestTotal: Dec;
  /** Сумма экономии против следующей по выгоде ставки по юрлицам */
  savingTotal: Dec;
  /** Расчёты calcTax, на которых стоит сравнение: по ним шаги, правила и допущения */
  runs: { rate: Rate; result: CalcResult; entityIds: string[] | 'all' }[];
}

/**
 * Налог по трём ставкам и лучшая ставка для каждого юрлица. Три прогона calcTax (по одному на
 * ставку), поэтому у каждой цифры есть шаги и правила. Лучшая ставка и экономия считаются здесь, а
 * не в тексте ответа: ответ только подставляет числа в слова.
 */
export function compareRates(
  args: { entityIds: string[] | 'all'; period: Period; scenario?: ForecastScenario },
  data: CalcData,
): RateComparison {
  const picked = pickEntities(args.entityIds, data);
  const choice = picked.filter((e) => e.taxRegime !== 'osno');
  const osno = picked.filter((e) => e.taxRegime === 'osno');
  const idsOf = (list: EntityInput[]): string[] | 'all' =>
    list.length === data.entities.length ? 'all' : list.map((e) => e.id);
  const base = { tax: 'vat' as const, period: args.period, scenario: args.scenario };

  const runs: RateComparison['runs'] = [];
  if (choice.length > 0) {
    for (const rate of [5, 7] as const) {
      runs.push({ rate, entityIds: idsOf(choice), result: calcTax({ ...base, entityIds: choice.map((e) => e.id), rate }, data) });
    }
  }
  // прогон на 22% берёт и юрлица на ОСНО: для них он единственный
  runs.push({ rate: 22, entityIds: idsOf(picked), result: calcTax({ ...base, entityIds: picked.map((e) => e.id), rate: 22 }, data) });

  const taxOf = (rate: Rate, id: string): Dec => {
    const e = runs.find((r) => r.rate === rate)!.result.entities.find((x) => x.entityId === id)!;
    if (e.tax === null) throw new CalcInputError(`Налог ${e.name} по ставке ${rate}% не рассчитан`);
    return e.tax;
  };

  const rows: RateRow[] = choice.map((e) => {
    const tax = { 5: taxOf(5, e.id), 7: taxOf(7, e.id), 22: taxOf(22, e.id) } as Record<Rate, Dec>;
    const months = runs.find((r) => r.rate === 22)!.result.entities.find((x) => x.entityId === e.id)!.months;
    const exemptAll = months.length > 0 && months.every((m) => m.exempt);
    if (exemptAll) {
      return { entityId: e.id, name: e.name, tax, exemptAll, best: null, against: null, saving: null };
    }
    const sorted = [...RATES].sort((a, b) => {
      const d = tax[a].comparedTo(tax[b]);
      return d !== 0 ? d : a - b;
    });
    const best = sorted[0]!;
    const against = sorted[1]!;
    return { entityId: e.id, name: e.name, tax, exemptAll, best, against, saving: tax[against].minus(tax[best]) };
  });
  const osnoRows = osno.map((e) => ({ entityId: e.id, name: e.name, tax: taxOf(22, e.id) }));

  const totals = {
    5: sum(rows.map((r) => r.tax[5])),
    7: sum(rows.map((r) => r.tax[7])),
    22: sum(rows.map((r) => r.tax[22])),
  } as Record<Rate, Dec>;
  const first = runs[0]!.result;
  return {
    period: args.period,
    periodLabel: first.periodLabel,
    scenario: first.scenario,
    rows,
    osno: osnoRows,
    totals,
    bestTotal: sum([...rows.map((r) => (r.best !== null ? r.tax[r.best] : r.tax[22])), ...osnoRows.map((r) => r.tax)]),
    savingTotal: sum(rows.map((r) => r.saving ?? ZERO)),
    runs,
  };
}

/**
 * Налог за период с происхождением каждой цифры.
 *
 *  vat     НДС по ставке (выбранной или заданной): R × 5 / 105, R × 7 / 107, R × 22 / 122 × (1 - p);
 *          освобождённое юрлицо платит со следующего месяца после пересечения порога
 *  usn     налог по УСН: налог года (incomeTax) раскладывается по долям выручки периода
 *  profit  налог на прибыль юрлиц на ОСНО: то же
 *
 * Бросает CalcInputError (неизвестное юрлицо, ставка) и PeriodError (некорректный период).
 * Нет правил на год периода: налог за этот год null, предупреждение no_rules, выручка показана.
 */
export function calcTax(args: CalcTaxArgs, inputData: CalcData): CalcResult {
  let data = inputData;
  const { today } = data;
  if (!['vat', 'usn', 'profit'].includes(args.tax)) {
    throw new CalcInputError(`Неизвестный налог: ${String(args.tax)}`);
  }
  if (args.rate !== undefined && !RATES.includes(args.rate)) {
    throw new CalcInputError(`Ставка НДС должна быть 5, 7 или 22: ${String(args.rate)}`);
  }
  let scenario: ScenarioRun | null = null;
  if (args.scenario) {
    const prepared = prepareScenario(args, data, args.scenario);
    data = prepared.data;
    scenario = prepared.scenario;
  }
  const entities = pickEntities(args.entityIds, data);
  const resolved = resolvePeriod(args.period, today);
  if (scenario && resolved.months.some((m) => m.year !== scenario!.spec.year)) {
    throw new CalcInputError(`Прогноз на ${scenario.spec.year} год считает только периоды этого года`);
  }

  const years = new Map<number, YearRules | null>();
  for (const y of new Set(resolved.months.map((m) => m.year))) {
    years.set(y, yearRules(data, resolved, y));
  }

  const run: Run = {
    args,
    data,
    today,
    resolved,
    log: new StepLog(),
    warnings: [],
    rows: new Map(data.revenue.map((r) => [rowKey(r.entityId, r.year, r.month), r])),
    scenario,
    years,
    ruleRefs: new Map(),
    exemptFrom: new Map(),
  };

  for (const [y, yr] of years) {
    if (!yr) {
      warn(run, {
        kind: 'no_rules',
        level: 'warn',
        entityId: null,
        text: `Нет правил на ${y} год: налог за него не рассчитан, показана только выручка. Добавьте записи в справочник правил.`,
      });
    }
  }

  const results = entities.map((e) => calcEntity(run, e));
  const used = results.filter((r) => r.applicable);

  // итог по группе
  const ids = used.filter((r) => r.taxStep !== null).map((r) => r.taxStep!);
  let total: Dec | null = null;
  let totalStep: FormulaStep | null = null;
  if (used.length > 0 && used.every((r) => r.tax !== null)) {
    total = sum(used.map((r) => r.tax!));
    totalStep = sumStep(run, {
      label: `Группа, ${resolved.label}`,
      text: `${TAX_WORD[args.tax]} за период, сумма по юрлицам: ${moneyText(total)}`,
      ids,
      round: false,
      entityId: null,
      result: total,
    });
  }

  let revenue: Dec | null = null;
  let revenueStepGroup: FormulaStep | null = null;
  if (used.length > 0 && used.every((r) => r.revenue !== null)) {
    const revIds = used.filter((r) => r.revenueStep !== null).map((r) => r.revenueStep!);
    revenue = sum(used.map((r) => r.revenue!));
    revenueStepGroup = sumStep(run, {
      label: `Группа, ${resolved.label}`,
      text: `выручка с НДС за период, сумма по юрлицам: ${moneyText(revenue)}`,
      ids: revIds,
      round: false,
      entityId: null,
      result: revenue,
    });
  } else if (used.length === 0) {
    revenue = ZERO;
  }

  // итоги по месяцам для группы; пусто, если по какому-то из юрлиц месяц посчитать нельзя
  const sumKnown = (values: (Dec | null)[]): Dec | null =>
    values.some((v) => v === null) ? null : sum(values as Dec[]);
  const months: GroupMonthResult[] = resolved.months.map((rm, i) => {
    const cells = used.map((r) => r.months[i]!);
    const statuses = new Set(cells.map((c) => c.status));
    return {
      key: rm.key,
      label: monthLabel(rm.year, rm.month),
      // юрлица могут расходиться (у одного факт есть, у другого нет): тогда месяц частичный
      status: statuses.size === 1 ? [...statuses][0]! : statuses.size === 0 ? rm.status : 'partial',
      coverage: rm.coverage,
      revenue: sumKnown(cells.map((c) => c.revenue)),
      tax: sumKnown(cells.map((c) => c.tax)),
    };
  });

  const rates = new Set(used.map((r) => r.rate));
  const warnings = [...run.warnings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const allStatuses = used.flatMap((r) => r.months.map((m) => m.status));

  return {
    tax: args.tax,
    taxName: TAX_LABEL[args.tax],
    period: args.period,
    periodLabel: resolved.label,
    from: resolved.from,
    to: resolved.to,
    rate: rates.size === 1 ? ([...rates][0] ?? null) : null,
    total,
    revenue,
    entities: results,
    months,
    steps: run.log.steps,
    totalStep: totalStep?.id ?? null,
    revenueStep: revenueStepGroup?.id ?? null,
    rules: [...run.ruleRefs.values()].sort((a, b) => a.key.localeCompare(b.key) || a.validFrom.localeCompare(b.validFrom)),
    source: data.source,
    asOf: toIsoDate({ year: today.year, month: today.month, day: today.day }),
    kind: allStatuses.length > 0 ? periodKindOf(allStatuses) : resolved.kind,
    warnings,
    assumptions: scenario ? scenarioAssumptions(run, used) : [],
    scenario: scenario ? { ...scenario.spec, limitsApproved: scenario.limitsApproved } : null,
  };
}

/**
 * Признак данных за период по всем юрлицам: факт, прогноз или смесь. Тот же вывод, что в calcTax
 * (прошедший месяц без факта в источнике считается прогнозом). Используется дашбордом.
 */
export function dataKind(data: CalcData, period: Period): PeriodKind {
  const resolved = resolvePeriod(period, data.today);
  const ctx: BasisCtx = {
    data,
    today: data.today,
    rows: new Map(data.revenue.map((r) => [rowKey(r.entityId, r.year, r.month), r])),
    scenario: null,
  };
  const statuses: MonthStatus[] = [];
  for (const e of data.entities) {
    for (const rm of resolved.months) statuses.push(monthBasis(ctx, e, rm).status);
  }
  return statuses.length > 0 ? periodKindOf(statuses) : resolved.kind;
}

/**
 * Проверка происхождения: шаги пересчитываются по своим выражениям, а каждое число результата
 * (выручка и налог по месяцам, по юрлицам, итоги) совпадает с результатом названного шага.
 * Возвращает список нарушений, пустой список означает «все цифры объяснены».
 */
export function verifyCalcResult(result: CalcResult): string[] {
  const problems = verifySteps(result.steps);
  const byId = new Map(result.steps.map((s) => [s.id, s]));
  const check = (what: string, value: Dec | null, stepId: string | null) => {
    if (value === null) {
      if (stepId !== null) problems.push(`${what}: значения нет, а шаг ${stepId} назван`);
      return;
    }
    if (stepId === null) {
      problems.push(`${what}: число без шага формулы`);
      return;
    }
    const step = byId.get(stepId);
    if (!step) {
      problems.push(`${what}: шаг ${stepId} не найден`);
      return;
    }
    if (step.result.minus(value).abs().gt(VERIFY_TOLERANCE)) {
      problems.push(`${what}: ${value.toString()} не совпадает с шагом ${stepId} (${step.result.toString()})`);
    }
  };

  for (const e of result.entities) {
    if (!e.applicable) continue;
    for (const m of e.months) {
      check(`${e.entityId} ${m.key} выручка`, m.revenue, m.revenueStep);
      check(`${e.entityId} ${m.key} налог`, m.tax, m.taxStep);
    }
    if (e.months.length > 0) {
      check(`${e.entityId} выручка за период`, e.revenue, e.revenueStep);
      check(`${e.entityId} налог за период`, e.tax, e.taxStep);
    }
  }
  check('итог по группе', result.total, result.totalStep);
  if (result.revenueStep !== null) check('выручка по группе', result.revenue, result.revenueStep);
  return problems;
}
