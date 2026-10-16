import { crossing, monthAmount, selectedRate } from './calc';
import { ZERO, dec, round2, sum, type Dec } from './decimal';
import { REGIME_LABEL } from './income-tax';
import { MONTHS_GENITIVE, mln, pct, pluralRu, rub } from './format';
import { formatPeriod, type Period } from './period';
import { numText } from './provenance';
import { buildRuleSet } from './rules';
import {
  CalcInputError,
  calcTax,
  pickEntities,
  type CalcData,
  type CalcResult,
  type TaxKind,
} from './service';
import type { CalendarDay, Moment } from './time';
import {
  OSNO_RATE,
  type CalcCtx,
  type EntityInput,
  type EntityWhatIf,
  type TaxRegime,
  type VatStatus,
  type WhatIfLabel,
  type WhatIfMonthPart,
} from './types';

/**
 * Сценарий «что если»: пересчёт года при условии, которого в данных нет. Две опоры:
 *
 *  1. Формулы те же, что у дашборда. Сценарий лишь подменяет у юрлица выручку идущего и будущих
 *     месяцев (EntityInput.whatIf), после чего работают те же calcTax, crossing, incomeTax. Нулевое
 *     изменение даёт ровно базовые числа.
 *  2. Данные дашборда не меняются: сценарий строится на копиях юрлиц внутри этого модуля, снимок
 *     CalcData и база остаются как были.
 *
 * Три вида изменения:
 *  cars    N машин: человек сам называет стоимость машины, цену сдачи, дни сдачи, месяц начала и (по
 *          желанию) расходы на машину в месяц; справочных допущений нет, без обязательных полей
 *          сценарий не считается. Добавочная выручка = N × цена сдачи × дни, с месяца начала до конца
 *          года; входной НДС по машинам идёт к вычету у плательщика на ставке 22%; расходы на машину
 *          входят в расходы юрлица;
 *  growth  выручка прогнозных месяцев (идущий и будущие) умножается на 1 + X / 100;
 *  amount  заданная сумма с НДС раскладывается по прогнозным месяцам по весам сезонности.
 *
 * Допущения: доля закупок с входным НДС, выбранные ставки и правила года не меняются. Порядок
 * списания стоимости машин в расходы (амортизация, основные средства на УСН) ядро не моделирует:
 * ответ говорит об этом прямо.
 */

/** Параметры парка машин из карточки чата. Ядро ничего не подставляет само. */
export interface FleetInput {
  /** Стоимость одной машины, ₽ */
  cost: number;
  /** true: в стоимости есть НДС; false: стоимость названа без НДС */
  costWithVat: boolean;
  /** Цена сдачи, ₽ в сутки, с НДС (как вся выручка в расчёте) */
  rentPerDay: number;
  /** Дней сдачи в месяц */
  rentDays: number;
  /** Первый месяц сдачи, 0..11: не раньше месяца, следующего за идущим */
  startMonth: number;
  /** Расходы на одну машину в месяц, ₽ (лизинг, страховка, обслуживание); 0: не названы */
  expensesPerMonth: number;
}

/** Поля сценария «машины», без которых он не считается (расходы необязательны). */
export type FleetField = 'cars' | 'cost' | 'costWithVat' | 'rentPerDay' | 'rentDays' | 'startMonth';

export const FLEET_FIELD_LABEL: Record<FleetField, string> = {
  cars: 'число машин',
  cost: 'стоимость машины',
  costWithVat: 'с НДС или без НДС',
  rentPerDay: 'цена сдачи в сутки',
  rentDays: 'дней сдачи в месяц',
  startMonth: 'месяц начала сдачи',
};

/** Дней сдачи в месяц по умолчанию: человек видит это значение в карточке и меняет его. */
export const FLEET_DEFAULT_RENT_DAYS = 20;
/** Быстрые варианты цены в карточке, когда значения в вопросе не названы. */
export const FLEET_QUICK_COST = [2_000_000, 3_000_000, 5_000_000] as const;
export const FLEET_QUICK_RENT = [5_000, 8_000, 12_000] as const;

export type WhatIfRequest =
  /** `cars: null`: число машин ещё не названо (запрос неполный, посчитать нельзя) */
  | { kind: 'cars'; cars: number | null; fleet?: Partial<FleetInput> }
  | { kind: 'growth'; percent: number }
  /** Рубли с НДС за все прогнозные месяцы; отрицательное значение это снижение */
  | { kind: 'amount'; amount: number };

export type CarsRequest = Extract<WhatIfRequest, { kind: 'cars' }>;

export interface WhatIfSpec {
  request: WhatIfRequest;
  /** Юрлица, у которых меняется выручка; 'all' это вся группа */
  entityIds: string[] | 'all';
}

/** Границы входных чисел: защита от опечатки, не бизнес-правило. */
export const WHATIF_MAX_CARS = 50;
export const WHATIF_PERCENT_MIN = -90;
export const WHATIF_PERCENT_MAX = 500;
export const FLEET_MAX_COST = 1_000_000_000;
export const FLEET_MAX_RENT_PER_DAY = 10_000_000;
export const FLEET_MAX_EXPENSES = 100_000_000;

/** Чего не хватает в запросе «машины». Пустой список: можно считать. */
export function missingFleetFields(r: CarsRequest): FleetField[] {
  const f = r.fleet ?? {};
  const out: FleetField[] = [];
  if (r.cars === null || r.cars === undefined) out.push('cars');
  if (f.cost === undefined || f.cost === null) out.push('cost');
  if (f.costWithVat === undefined || f.costWithVat === null) out.push('costWithVat');
  if (f.rentPerDay === undefined || f.rentPerDay === null) out.push('rentPerDay');
  if (f.rentDays === undefined || f.rentDays === null) out.push('rentDays');
  if (f.startMonth === undefined || f.startMonth === null) out.push('startMonth');
  return out;
}

/** Выручка на машину в месяц с НДС: цена сдачи в сутки × дни сдачи. Ту же функцию вызывает карточка в чате. */
export function fleetRevenuePerCar(rentPerDay: number | string | Dec, rentDays: number | string | Dec): Dec {
  return dec(rentPerDay).times(dec(rentDays));
}

export type WhatIfErrorReason =
  /** Не заданы обязательные поля сценария «машины» (список в `fields`) */
  | 'missing_fields'
  /** До конца года не осталось месяцев, в которых сценарий мог бы что-то изменить */
  | 'no_months'
  /** Число вне допустимых границ или выручка месяца ушла бы ниже нуля */
  | 'bad_input';

export class WhatIfError extends CalcInputError {
  constructor(
    message: string,
    public reason: WhatIfErrorReason,
    public entityId: string | null = null,
    public fields: FleetField[] = [],
  ) {
    super(message);
    this.name = 'WhatIfError';
  }
}

// ===== Применение сценария =====

/** Почему вычета входного НДС по машинам нет или есть. */
export type FleetDeduction =
  /** Плательщик на ставке 22% с вычетами: входной НДС принят к вычету */
  | 'applied'
  /** Выбрана ставка 5% или 7%: вычетов нет */
  | 'low_rate'
  /** Юрлицо освобождено от НДС: вычета нет */
  | 'exempt'
  /** До конца года месяцев не осталось: ничего не куплено */
  | 'none';

/** Что парк машин даёт юрлицу: выручка, расходы, входной НДС, окупаемость. Все числа Decimal. */
export interface FleetEffect {
  cars: number;
  /** Стоимость одной машины, как названа */
  cost: Dec;
  costWithVat: boolean;
  /** Входной НДС в одной машине (по общей ставке справочника) */
  inputVatPerCar: Dec;
  /** Цена сдачи в сутки с НДС и дни сдачи в месяц */
  rentPerDay: Dec;
  rentDays: number;
  /** Первый месяц сдачи 0..11 и число месяцев сдачи до конца года */
  startMonth: number;
  monthsCount: number;
  /** Выручка на одну машину в месяц с НДС: цена сдачи × дни */
  perCar: Dec;
  /** Расходы на одну машину в месяц и всего за месяцы сдачи по всем машинам */
  expensesPerCar: Dec;
  expensesTotal: Dec;
  /** Входной НДС по всем машинам */
  inputVat: Dec;
  /** Ставка НДС юрлица в расчёте и общая ставка справочника */
  vatRate: number;
  generalRate: number;
  deduction: FleetDeduction;
  /** Сумма, принятая к вычету: входной НДС при `applied`, иначе 0 */
  deducted: Dec;
  /** Окупаемость, месяцев: стоимость машины / (выручка на машину − расходы); null: не окупается */
  paybackMonths: Dec | null;
}

/** Что сценарий сделал с одним юрлицом. */
export interface WhatIfEntityChange {
  entityId: string;
  name: string;
  regime: TaxRegime;
  /** Номера месяцев 0..11, в которых выручка изменилась по условию сценария */
  months: number[];
  /** Выручка на машину в месяц; только у сценария «машины» */
  perCar: Dec | null;
  /** Добавочная выручка в месяц (N × на машину); только у сценария «машины» */
  perMonth: Dec | null;
  /** Парк машин; только у сценария «машины» */
  fleet: FleetEffect | null;
  /** Изменение выручки года с НДС */
  delta: Dec;
}

export interface WhatIfApplied {
  /** Снимок данных, в котором у юрлиц из сценария заменена выручка; остальное то же */
  data: CalcData;
  /** Юрлица, которых сценарий затронул (в порядке справочника) */
  changes: WhatIfEntityChange[];
  /** Первый месяц действия сценария, 0..11; больше 11: месяцев не осталось */
  from: number;
  /** Прогнозные месяцы сценария 0..11 */
  months: number[];
  /** Выручка изменилась хотя бы у одного юрлица */
  changed: boolean;
}

const notFinite = (n: unknown): boolean => typeof n !== 'number' || !Number.isFinite(n);

function checkRequest(r: WhatIfRequest, today: Moment): void {
  switch (r.kind) {
    case 'cars': {
      const missing = missingFleetFields(r);
      if (missing.length > 0) {
        throw new WhatIfError(
          `Не заданы: ${missing.map((f) => FLEET_FIELD_LABEL[f]).join(', ')}`,
          'missing_fields',
          null,
          missing,
        );
      }
      const f = r.fleet as FleetInput;
      if (!Number.isInteger(r.cars) || r.cars! < 1 || r.cars! > WHATIF_MAX_CARS) {
        throw new WhatIfError(`Число машин должно быть от 1 до ${WHATIF_MAX_CARS}`, 'bad_input');
      }
      if (notFinite(f.cost) || f.cost <= 0 || f.cost > FLEET_MAX_COST) {
        throw new WhatIfError('Стоимость машины должна быть больше нуля', 'bad_input');
      }
      if (notFinite(f.rentPerDay) || f.rentPerDay <= 0 || f.rentPerDay > FLEET_MAX_RENT_PER_DAY) {
        throw new WhatIfError('Цена сдачи в сутки должна быть больше нуля', 'bad_input');
      }
      if (!Number.isInteger(f.rentDays) || f.rentDays < 1 || f.rentDays > 31) {
        throw new WhatIfError('Дней сдачи в месяц должно быть от 1 до 31', 'bad_input');
      }
      if (f.expensesPerMonth !== undefined && (notFinite(f.expensesPerMonth) || f.expensesPerMonth < 0 || f.expensesPerMonth > FLEET_MAX_EXPENSES)) {
        throw new WhatIfError('Расходы на машину в месяц заданы неверно', 'bad_input');
      }
      // в декабре месяцев не остаётся: месяц начала не проверяется, сценарий ничего не меняет
      if (today.month < 11) {
        if (!Number.isInteger(f.startMonth) || f.startMonth <= today.month || f.startMonth > 11) {
          throw new WhatIfError('Сдача может начаться не раньше следующего месяца этого года', 'bad_input');
        }
      }
      return;
    }
    case 'growth':
      if (!Number.isFinite(r.percent) || r.percent < WHATIF_PERCENT_MIN || r.percent > WHATIF_PERCENT_MAX) {
        throw new WhatIfError(
          `Изменение выручки должно быть от ${WHATIF_PERCENT_MIN} до ${WHATIF_PERCENT_MAX} процентов`,
          'bad_input',
        );
      }
      return;
    case 'amount':
      if (!Number.isFinite(r.amount) || r.amount === 0 || Math.abs(r.amount) > 1_000_000_000_000) {
        throw new WhatIfError('Сумма изменения выручки задана неверно', 'bad_input');
      }
      return;
  }
}

/**
 * Подменяет выручку юрлиц сценария. Не меняет `data` и его юрлица: возвращает копии.
 * Выручка идущего месяца по сценарию машин не меняется: машины сдают с выбранного будущего месяца.
 */
export function applyWhatIf(data: CalcData, spec: WhatIfSpec): WhatIfApplied {
  const { today } = data;
  checkRequest(spec.request, today);
  const picked = pickEntities(spec.entityIds, data);
  const scope = new Set(picked.map((e) => e.id));
  const req = spec.request;
  if (req.kind === 'cars' && scope.size !== 1) {
    throw new WhatIfError('Машины относятся к одному юрлицу', 'bad_input');
  }
  const fleet = req.kind === 'cars' ? (req.fleet as FleetInput) : null;
  // машины считаются с выбранного месяца, процент и сумма с идущего (прогнозные месяцы)
  const from = fleet ? (today.month < 11 ? fleet.startMonth : 12) : today.month;
  const months: number[] = [];
  for (let m = from; m <= 11; m++) months.push(m);
  const ctx = { weights: data.weights };
  // общая ставка и выбранные ставки нужны только вычету по машинам
  const rules = fleet ? buildRuleSet(data.ruleRows, today) : null;
  const choices = data.choices[today.year] ?? {};

  const changes: WhatIfEntityChange[] = [];
  const entities = data.entities.map((e): EntityInput => {
    if (!scope.has(e.id)) return e;
    if (e.whatIf) throw new CalcInputError(`У юрлица ${e.name} уже задан сценарий`);

    // сумма делится по весам прогнозных месяцев; копейки доводятся на последнем месяце
    const spread = new Map<number, Dec>();
    if (req.kind === 'amount' && months.length > 0) {
      const weights = months.map((m) => data.weights[m]!);
      const total = sum(weights);
      let left = dec(req.amount);
      months.forEach((m, i) => {
        const part = i === months.length - 1 ? left : round2(dec(req.amount).times(weights[i]!).div(total));
        spread.set(m, part);
        left = left.minus(part);
      });
    }

    // парк машин: выручка, расходы, входной НДС, окупаемость
    let effect: FleetEffect | null = null;
    if (fleet && req.kind === 'cars') {
      const g = rules!.generalRate;
      const cars = req.cars!;
      const perCar = fleetRevenuePerCar(fleet.rentPerDay, fleet.rentDays);
      const cost = dec(fleet.cost);
      const inputVatPerCar = fleet.costWithVat ? cost.times(g).div(100 + g) : cost.times(g).div(100);
      const inputVat = inputVatPerCar.times(cars);
      const vatRate = e.taxRegime === 'osno' ? OSNO_RATE : selectedRate(e, choices);
      const deduction: FleetDeduction =
        months.length === 0 ? 'none' : e.status === 'exempt' ? 'exempt' : vatRate === g ? 'applied' : 'low_rate';
      const expensesPerCar = dec(fleet.expensesPerMonth ?? 0);
      const net = perCar.minus(expensesPerCar);
      effect = {
        cars,
        cost,
        costWithVat: fleet.costWithVat,
        inputVatPerCar,
        rentPerDay: dec(fleet.rentPerDay),
        rentDays: fleet.rentDays,
        startMonth: fleet.startMonth,
        monthsCount: months.length,
        perCar,
        expensesPerCar,
        expensesTotal: expensesPerCar.times(cars).times(months.length),
        inputVat,
        vatRate,
        generalRate: g,
        deduction,
        deducted: deduction === 'applied' ? inputVat : ZERO,
        paybackMonths: net.gt(0) ? cost.div(net) : null,
      };
    }

    const parts: (WhatIfMonthPart | undefined)[] = new Array<WhatIfMonthPart | undefined>(12).fill(undefined);
    let delta = ZERO;
    const touched: number[] = [];
    for (let m = today.month; m <= 11; m++) {
      const base = monthAmount(e, ctx, m, today);
      let factor = dec(1);
      let extra = ZERO;
      if (m >= from) {
        if (req.kind === 'growth') factor = dec(1).plus(dec(req.percent).div(100));
        else if (effect) extra = effect.perCar.times(effect.cars);
        else extra = spread.get(m) ?? ZERO;
      }
      const amount = base.times(factor).plus(extra);
      if (amount.isNegative()) {
        throw new WhatIfError(`Выручка месяца у ${e.name} ушла бы ниже нуля`, 'bad_input', e.id);
      }
      parts[m] = { base, factor, extra };
      // вычет входного НДС: в месяце начала сдачи (машины приняты к учёту к началу сдачи)
      if (effect && effect.deduction === 'applied' && m === effect.startMonth) {
        parts[m] = { base, factor, extra, vatDeduct: effect.deducted };
      }
      const change = amount.minus(base);
      if (!change.isZero()) {
        delta = delta.plus(change);
        touched.push(m);
      }
    }

    changes.push({
      entityId: e.id,
      name: e.name,
      regime: e.taxRegime,
      months: touched,
      perCar: effect ? effect.perCar : null,
      perMonth: effect ? effect.perCar.times(effect.cars) : null,
      fleet: effect,
      delta,
    });
    const whatIf: EntityWhatIf = { parts };
    // годовой прогноз сдвигается ровно на изменение: доходы без НДС, база порога и налог УСН
    // читают именно его; расходы на машины входят в расходы юрлица (для УСН «доходы» их не читают)
    return {
      ...e,
      annualRevenue: e.annualRevenue.plus(delta),
      annualExpenses: effect ? e.annualExpenses.plus(effect.expensesTotal) : e.annualExpenses,
      whatIf,
    };
  });

  const changed = changes.some((c) => !c.delta.isZero());
  return {
    // без изменения данные остаются как были: нулевой сценарий равен базовому расчёту
    data: changed ? { ...data, entities } : data,
    changes,
    from,
    months,
    changed,
  };
}

// ===== Сравнение «сейчас» и «по сценарию» =====

/** Значение «сейчас» и «по сценарию»; null: посчитать нельзя (нет правил или данных). */
export interface WhatIfPair {
  base: Dec | null;
  scenario: Dec | null;
}

/** Порог освобождения: дата пересечения и месяц, с которого начнётся НДС. */
export interface ThresholdState {
  /** Дата пересечения порога в этом году; null: в этом году порог не пересекается */
  crossing: CalendarDay | null;
  /** Первый месяц с НДС: год и месяц 0..11; null, если порог не пересекается */
  vatFrom: { year: number; month: number } | null;
}

export interface WhatIfEntityRow {
  entityId: string;
  name: string;
  regime: TaxRegime;
  vatStatus: VatStatus;
  /** Налог с доходов по режиму: УСН или налог на прибыль */
  incomeTaxKind: 'usn' | 'profit';
  /** Выручка года с НДС: факт прошедших месяцев и прогноз остальных */
  revenue: WhatIfPair;
  /** НДС за год */
  vat: WhatIfPair;
  /** УСН или налог на прибыль за год */
  incomeTax: WhatIfPair;
  /** НДС и налог с доходов вместе */
  taxes: WhatIfPair;
  /** Освобождённое юрлицо: порог; null у плательщика */
  threshold: { limit: Dec; base: ThresholdState; scenario: ThresholdState } | null;
  /** Плательщик: доля выручки года от лимита ставки 5% */
  limit5: { limit: Dec; base: Dec; scenario: Dec } | null;
}

export interface WhatIfUnified {
  /** Признаки единого бизнеса из справочника: «один бренд, один сайт, общий парк» */
  signs: string;
  /** Лимит ставки 5% */
  limit: Dec;
  /** Число юрлиц на УСН в сумме */
  count: number;
  /** Выручка юрлиц на УСН за год и её доля от лимита */
  revenue: WhatIfPair;
  share: WhatIfPair;
}

export interface WhatIfComparison {
  spec: WhatIfSpec;
  year: number;
  /** День расчёта: к нему пересечение порога считается «уже случившимся» */
  today: CalendarDay;
  /** Название сценария одной фразой: «5 машин у ИП Дельта» */
  title: string;
  /** Ключ сценария для отметок «сверил» */
  key: string;
  /** Прогнозные месяцы сценария: «с ноября по декабрь 2026» */
  monthsLabel: string;
  /** Месяцы, в которых выручка изменилась, 0..11 */
  months: number[];
  /** Сценарий ничего не меняет (ноль процентов, месяцев не осталось) */
  noChange: boolean;
  changes: WhatIfEntityChange[];
  /** Допущения сценария: что принято, потому что точных данных нет */
  assumptions: string[];
  /** Парк машин (сценарий «машины»): числа и готовые фразы; null у остальных сценариев */
  fleet: FleetSummary | null;
  /** Юрлица сценария в порядке справочника */
  rows: WhatIfEntityRow[];
  /** Итоги по юрлицам сценария */
  totals: { revenue: WhatIfPair; vat: WhatIfPair; incomeTax: WhatIfPair; taxes: WhatIfPair };
  /** Признаки единого бизнеса; null, если к сценарию не относятся */
  unified: WhatIfUnified | null;
  /** Расчёты calcTax за год: «сейчас» и «по сценарию», с пометкой и допущениями */
  base: CalcResult[];
  scenario: CalcResult[];
  /** Правила текущего года: лимиты и порог */
  rules: { vatExemptLimit: Dec; limit5: Dec | null };
}

function monthRange(year: number, months: number[]): string {
  if (months.length === 0) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const first = months[0]! + 1;
  const last = months[months.length - 1]! + 1;
  const to = new Date(Date.UTC(year, last, 0)).getUTCDate();
  const period: Period = { kind: 'range', from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(to)}` };
  return formatPeriod(period);
}

/** Первый месяц с НДС по дате пересечения: после пересечения, с первого числа следующего месяца. */
function vatFrom(c: CalendarDay | null): ThresholdState['vatFrom'] {
  if (!c) return null;
  return c.month + 1 > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 };
}

function thresholdOf(e: EntityInput, ctx: CalcCtx, now: Moment): ThresholdState {
  const c = crossing(e, ctx, now);
  return { crossing: c, vatFrom: vatFrom(c) };
}

/** Название сценария: «5 машин у ИП Дельта», «рост выручки на 20% у группы». */
function titleOf(spec: WhatIfSpec, names: string[], all: boolean): string {
  const who = all ? 'у группы' : `у ${names.join(' и ')}`;
  const r = spec.request;
  switch (r.kind) {
    case 'cars':
      return `${r.cars} ${pluralRu(r.cars ?? 0, 'машина', 'машины', 'машин')} ${who}`;
    case 'growth':
      return `${r.percent >= 0 ? 'рост' : 'снижение'} выручки на ${numText(Math.abs(r.percent))}% ${who}`;
    case 'amount':
      return `${r.amount >= 0 ? 'рост' : 'снижение'} выручки на ${mln(Math.abs(r.amount), Math.abs(r.amount) % 100_000 === 0 ? 1 : 2)} ${who}`;
  }
}

function keyOf(spec: WhatIfSpec): string {
  const r = spec.request;
  const who = spec.entityIds === 'all' ? 'all' : [...spec.entityIds].sort().join('+');
  let what: string;
  if (r.kind === 'cars') {
    // другие цены, дни или месяц начала это другой сценарий: отметки «сверил» не переносятся
    const f = r.fleet ?? {};
    what =
      `cars${r.cars}-c${f.cost}${f.costWithVat ? 'v' : 'n'}-r${f.rentPerDay}x${f.rentDays}` +
      `-s${f.startMonth}-e${f.expensesPerMonth ?? 0}`;
  } else {
    what = r.kind === 'growth' ? `g${r.percent}` : `a${r.amount}`;
  }
  return `${what}@${who}`;
}

// ===== Парк машин: фразы =====

/** Фразы сценария «машины»: ответ агента, панель расчёта и Excel берут их отсюда. */
export interface FleetLines {
  /** Принятые значения одной строкой: «5 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = … » */
  values: string;
  /** Вычет входного НДС: сумма и формула или причина, почему вычета нет */
  deduction: string;
  /** Расходы на машину и как они влияют на налог по режиму юрлица */
  expenses: string;
  /** Окупаемость в месяцах по формуле или «не окупается» */
  payback: string;
  /** Что ядро не моделирует; пусто, если у режима юрлица этого эффекта нет */
  notModeled: string | null;
}

export interface FleetSummary {
  entityId: string;
  name: string;
  regime: TaxRegime;
  effect: FleetEffect;
  lines: FleetLines;
}

/** «в ноябре»: месяц начала сдачи, в котором принят вычет. */
const MONTHS_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
] as const;

const monthsWord = (n: number) => pluralRu(n, 'месяц', 'месяца', 'месяцев');
const carsWord = (n: number) => pluralRu(n, 'машина', 'машины', 'машин');
const paybackText = (v: Dec) => `${v.toFixed(1).replace('.', ',')} мес.`;
const rateWord = (g: number) => `${g} / ${100 + g}`;

/** Фразы парка машин по результату применения сценария к юрлицу. */
export function fleetLines(name: string, regime: TaxRegime, f: FleetEffect): FleetLines {
  const days = `${f.rentDays} ${pluralRu(f.rentDays, 'день', 'дня', 'дней')}`;
  const start = MONTHS_GENITIVE[f.startMonth];
  const values =
    `${f.cars} ${carsWord(f.cars)} по ${rub(f.cost)} ${f.costWithVat ? 'с НДС' : 'без НДС'}, ` +
    `сдача ${rub(f.rentPerDay)} в сутки × ${days} = ${rub(f.perCar)} в месяц на машину` +
    (f.monthsCount > 0 ? `, с ${start}` : ', но до конца года месяцев не осталось') +
    (f.expensesPerCar.gt(0) ? `, расходы ${rub(f.expensesPerCar)} в месяц на машину` : '');

  const g = f.generalRate;
  const inputFormula = f.costWithVat
    ? `${f.cars} × ${rub(f.cost)} × ${rateWord(g)}`
    : `${f.cars} × ${rub(f.cost)} × ${g}%`;
  let deduction: string;
  switch (f.deduction) {
    case 'applied':
      deduction =
        `Входной НДС по машинам ${rub(f.inputVat)} (${inputFormula}) принят к вычету в ${MONTHS_PREPOSITIONAL[f.startMonth]}: ` +
        `у ${name} ставка ${f.vatRate}% с вычетами`;
      break;
    case 'low_rate':
      deduction =
        `Вычета входного НДС по машинам нет: у ${name} выбрана ставка ${f.vatRate}%, при ней вычеты не применяются. ` +
        `Входной НДС по машинам ${rub(f.inputVat)} (${inputFormula}) в расчёт налога не включён`;
      break;
    case 'exempt':
      deduction =
        `Вычета входного НДС по машинам нет: у ${name} освобождение от НДС, вычеты не применяются. ` +
        `Входной НДС по машинам ${rub(f.inputVat)} (${inputFormula}) в расчёт налога не включён`;
      break;
    case 'none':
      deduction = 'Машины в этом году не куплены, входного НДС к вычету нет';
      break;
  }

  const regimeWord = REGIME_LABEL[regime];
  let expenses: string;
  if (f.deduction === 'none') {
    expenses = 'Расходов на машины в этом году нет';
  } else if (f.expensesPerCar.isZero()) {
    expenses = 'Расходы на машину в месяц не названы: в расходы юрлица ничего не добавлено';
  } else if (regime === 'usn_income') {
    expenses =
      `Расходы на машины ${f.cars} × ${rub(f.expensesPerCar)} × ${f.monthsCount} ${monthsWord(f.monthsCount)} = ` +
      `${rub(f.expensesTotal)} налог по УСН «доходы» не уменьшают`;
  } else {
    expenses =
      `Расходы на машины ${f.cars} × ${rub(f.expensesPerCar)} × ${f.monthsCount} ${monthsWord(f.monthsCount)} = ` +
      `${rub(f.expensesTotal)} добавлены к расходам юрлица (${regimeWord}), как расходы без НДС`;
  }

  const net = f.perCar.minus(f.expensesPerCar);
  const payback =
    f.paybackMonths === null
      ? `Машина не окупается: расходы ${rub(f.expensesPerCar)} в месяц не меньше выручки ${rub(f.perCar)} в месяц`
      : f.expensesPerCar.isZero()
        ? `Окупаемость: ${rub(f.cost)} / ${rub(f.perCar)} = ${paybackText(f.paybackMonths)}, по названной стоимости, налоги не учтены`
        : `Окупаемость: ${rub(f.cost)} / (${rub(f.perCar)} − ${rub(f.expensesPerCar)}) = ${rub(f.cost)} / ${rub(net)} = ${paybackText(f.paybackMonths)}, по названной стоимости, налоги не учтены`;

  // стоимость машины в расходах налога: порядок списания ядро не моделирует. У УСН «доходы» расходы
  // налог не меняют, говорить нечего
  const notModeled =
    regime === 'usn_income' || f.deduction === 'none'
      ? null
      : `Стоимость машин ${rub(f.cost.times(f.cars))} в расходы по налогу не включена: порядок списания основных средств ` +
        `(амортизация на ОСНО, списание на УСН «доходы минус расходы») в расчёте не моделируется, ` +
        `этот эффект не учтён, нужен бухгалтер`;

  return { values, deduction, expenses, payback, notModeled };
}

/** Допущения сценария одним списком: по ним панель расчёта, Excel и ответ агента. */
function assumptionsOf(spec: WhatIfSpec, applied: WhatIfApplied, year: number): string[] {
  const out: string[] = [];
  const r = spec.request;
  const months = monthRange(year, applied.months);
  if (r.kind === 'cars') {
    for (const c of applied.changes) {
      const f = c.fleet!;
      const lines = fleetLines(c.name, c.regime, f);
      out.push(
        `${c.name}: выручка на машину в месяц ${rub(f.perCar)} с НДС = цена сдачи ${rub(f.rentPerDay)} в сутки × ${f.rentDays} ${pluralRu(f.rentDays, 'день', 'дня', 'дней')} (значения из карточки)`,
      );
      out.push(
        `${c.name}: добавочная выручка ${f.cars} × ${rub(f.perCar)} = ${rub(c.perMonth!)} в месяц` +
          (months ? `, ${months}` : ', месяцев до конца года не осталось'),
      );
      out.push(lines.deduction);
      out.push(lines.expenses);
      if (lines.notModeled) out.push(lines.notModeled);
      out.push(lines.payback);
    }
    out.push(
      `Доля закупок с входным НДС, выбранные ставки НДС и правила ${year} года не меняются; вычет по машинам идёт сверх этой доли`,
    );
    return out;
  } else if (r.kind === 'growth') {
    const factor = dec(1).plus(dec(r.percent).div(100));
    out.push(
      `Выручка прогнозных месяцев (${months}) умножена на ${numText(factor)}: ` +
        `${r.percent >= 0 ? 'рост' : 'снижение'} на ${numText(Math.abs(r.percent))}%. Факт прошедших месяцев не меняется`,
    );
  } else {
    out.push(
      `Изменение выручки на ${rub(Math.abs(r.amount))} с НДС распределено по прогнозным месяцам (${months}) по весам сезонности`,
    );
  }
  out.push(
    `Расходы, доля закупок с входным НДС, выбранные ставки НДС и правила ${year} года не меняются`,
  );
  return out;
}

const labelOf = (role: WhatIfLabel['role'], title: string, key: string): WhatIfLabel => ({ role, title, key });

/** Налог за год по юрлицам группы одним запросом; null, если в группе нет подходящих юрлиц. */
function runYear(
  data: CalcData,
  year: number,
  tax: TaxKind,
  ids: string[],
): CalcResult | null {
  if (ids.length === 0) return null;
  return calcTax({ entityIds: ids, tax, period: { kind: 'year', year } }, data);
}

/**
 * Считает сценарий и сравнивает его с расчётом по данным за текущий год: выручка, НДС, УСН или
 * налог на прибыль по режиму юрлица, порог освобождения и доля лимита ставки 5%. Все числа это
 * calcTax и функции калькулятора дашборда. Бросает WhatIfError и CalcInputError.
 */
export function compareWhatIf(data: CalcData, spec: WhatIfSpec): WhatIfComparison {
  const applied = applyWhatIf(data, spec);
  const { today } = data;
  const year = today.year;
  const rules = buildRuleSet(data.ruleRows, today);
  const ctx: CalcCtx = { weights: data.weights, rules };

  const picked = pickEntities(spec.entityIds, data);
  const all = picked.length === data.entities.length;
  const key = keyOf(spec);
  const title = titleOf(spec, picked.map((e) => e.name), all);
  const assumptions = assumptionsOf(spec, applied, year);

  const ids = picked.map((e) => e.id);
  const usnIds = picked.filter((e) => e.taxRegime !== 'osno').map((e) => e.id);
  const osnoIds = picked.filter((e) => e.taxRegime === 'osno').map((e) => e.id);

  const sideRuns = (d: CalcData) => ({
    vat: runYear(d, year, 'vat', ids)!,
    usn: runYear(d, year, 'usn', usnIds),
    profit: runYear(d, year, 'profit', osnoIds),
  });
  const b = sideRuns(data);
  const s = sideRuns(applied.data);
  const label = (r: CalcResult, role: WhatIfLabel['role']): CalcResult => ({
    ...r,
    whatIf: labelOf(role, title, key),
    assumptions: role === 'scenario' ? [...r.assumptions, ...assumptions] : r.assumptions,
  });
  const order = (x: ReturnType<typeof sideRuns>, role: WhatIfLabel['role']) =>
    [x.vat, x.usn, x.profit].filter((r): r is CalcResult => r !== null).map((r) => label(r, role));

  const entityTax = (r: CalcResult | null, id: string): Dec | null =>
    r?.entities.find((e) => e.entityId === id && e.applicable)?.tax ?? null;
  const entityRevenue = (r: CalcResult | null, id: string): Dec | null =>
    r?.entities.find((e) => e.entityId === id)?.revenue ?? null;
  const plus = (a: Dec | null, c: Dec | null): Dec | null => (a === null || c === null ? null : a.plus(c));

  const scenarioById = new Map(applied.data.entities.map((e) => [e.id, e]));
  const rows: WhatIfEntityRow[] = picked.map((e) => {
    const sc = scenarioById.get(e.id)!;
    const kind: 'usn' | 'profit' = e.taxRegime === 'osno' ? 'profit' : 'usn';
    const inc = kind === 'usn' ? [b.usn, s.usn] : [b.profit, s.profit];
    const vat: WhatIfPair = { base: entityTax(b.vat, e.id), scenario: entityTax(s.vat, e.id) };
    const incomeTax: WhatIfPair = { base: entityTax(inc[0]!, e.id), scenario: entityTax(inc[1]!, e.id) };
    const payer = e.status === 'payer';
    return {
      entityId: e.id,
      name: e.name,
      regime: e.taxRegime,
      vatStatus: e.status,
      incomeTaxKind: kind,
      revenue: { base: entityRevenue(b.vat, e.id), scenario: entityRevenue(s.vat, e.id) },
      vat,
      incomeTax,
      taxes: { base: plus(vat.base, incomeTax.base), scenario: plus(vat.scenario, incomeTax.scenario) },
      threshold: payer
        ? null
        : { limit: rules.vatExemptLimit, base: thresholdOf(e, ctx, today), scenario: thresholdOf(sc, ctx, today) },
      limit5:
        // ставка 5% есть у УСН; у юрлица на ОСНО ставка НДС одна, лимита 5% для него нет
        payer && e.taxRegime !== 'osno' && rules.limit5 && !rules.limit5.isZero()
          ? {
              limit: rules.limit5,
              base: e.annualRevenue.div(rules.limit5),
              scenario: sc.annualRevenue.div(rules.limit5),
            }
          : null,
    };
  });

  const total = (pick: (r: WhatIfEntityRow) => WhatIfPair): WhatIfPair => {
    const side = (k: 'base' | 'scenario'): Dec | null => {
      let acc: Dec | null = ZERO;
      for (const r of rows) {
        const v = pick(r)[k];
        acc = acc === null || v === null ? null : acc.plus(v);
      }
      return acc;
    };
    return { base: side('base'), scenario: side('scenario') };
  };

  // признаки единого бизнеса: условие то же, что у предупреждения дашборда (warnings.ts), но сумма
  // берётся и по данным, и по сценарию; к сценарию относятся, если затронуто юрлицо на УСН
  let unified: WhatIfUnified | null = null;
  const usnAll = data.entities.filter((e) => e.taxRegime !== 'osno');
  if (rules.groupSigns && usnAll.length > 1 && rules.limit5 && picked.some((e) => e.taxRegime !== 'osno')) {
    const sumOf = (list: EntityInput[]) => sum(list.map((e) => round2(e.annualRevenue)));
    const baseSum = sumOf(usnAll);
    const scSum = sumOf(applied.data.entities.filter((e) => e.taxRegime !== 'osno'));
    unified = {
      signs: rules.groupSigns,
      limit: rules.limit5,
      count: usnAll.length,
      revenue: { base: baseSum, scenario: scSum },
      share: { base: baseSum.div(rules.limit5), scenario: scSum.div(rules.limit5) },
    };
  }

  return {
    spec,
    year,
    today: { year: today.year, month: today.month, day: today.day },
    title,
    key,
    monthsLabel: monthRange(year, applied.months),
    months: [...new Set(applied.changes.flatMap((c) => c.months))].sort((x, y) => x - y),
    noChange: !applied.changed,
    changes: applied.changes,
    assumptions,
    fleet: fleetOf(applied),
    rows,
    totals: {
      revenue: total((r) => r.revenue),
      vat: total((r) => r.vat),
      incomeTax: total((r) => r.incomeTax),
      taxes: total((r) => r.taxes),
    },
    unified,
    base: order(b, 'base'),
    scenario: order(s, 'scenario'),
    rules: { vatExemptLimit: rules.vatExemptLimit, limit5: rules.limit5 },
  };
}

function fleetOf(applied: WhatIfApplied): FleetSummary | null {
  const c = applied.changes.find((x) => x.fleet);
  if (!c?.fleet) return null;
  return { entityId: c.entityId, name: c.name, regime: c.regime, effect: c.fleet, lines: fleetLines(c.name, c.regime, c.fleet) };
}

// ===== Подписи для ответа =====

/** «1 января 2027», «1 декабря»: с какого числа начнётся НДС. Год называется, если он не текущий. */
export function vatStartLabel(s: ThresholdState, todayYear: number): string | null {
  if (!s.vatFrom) return null;
  const { year, month } = s.vatFrom;
  return `1 ${MONTHS_GENITIVE[month]}${year === todayYear ? '' : ` ${year}`}`;
}

/** Доля лимита в процентах с одним знаком: «10,4%». */
export function shareLabel(share: Dec): string {
  return pct(share, 1);
}
