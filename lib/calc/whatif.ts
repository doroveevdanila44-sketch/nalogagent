import { crossing, monthAmount } from './calc';
import { ZERO, dec, round2, sum, type Dec } from './decimal';
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
import type {
  CalcCtx,
  EntityInput,
  EntityWhatIf,
  TaxRegime,
  VatStatus,
  WhatIfLabel,
  WhatIfMonthPart,
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
 *  cars    N машин: добавочная выручка в месяц = N × выручка на машину в месяц из справочника юрлица,
 *          с ближайшего месяца до конца года;
 *  growth  выручка прогнозных месяцев (идущий и будущие) умножается на 1 + X / 100;
 *  amount  заданная сумма с НДС раскладывается по прогнозным месяцам по весам сезонности.
 *
 * Допущения: расходы, доля закупок с входным НДС, выбранные ставки и правила года не меняются.
 */

export type WhatIfRequest =
  | { kind: 'cars'; cars: number }
  | { kind: 'growth'; percent: number }
  /** Рубли с НДС за все прогнозные месяцы; отрицательное значение это снижение */
  | { kind: 'amount'; amount: number };

export interface WhatIfSpec {
  request: WhatIfRequest;
  /** Юрлица, у которых меняется выручка; 'all' это вся группа */
  entityIds: string[] | 'all';
}

/** Границы входных чисел: защита от опечатки, не бизнес-правило. */
export const WHATIF_MAX_CARS = 50;
export const WHATIF_PERCENT_MIN = -90;
export const WHATIF_PERCENT_MAX = 500;

export type WhatIfErrorReason =
  /** У юрлица в справочнике нет выручки на машину в месяц */
  | 'no_car_revenue'
  /** До конца года не осталось месяцев, в которых сценарий мог бы что-то изменить */
  | 'no_months'
  /** Число вне допустимых границ или выручка месяца ушла бы ниже нуля */
  | 'bad_input';

export class WhatIfError extends CalcInputError {
  constructor(
    message: string,
    public reason: WhatIfErrorReason,
    public entityId: string | null = null,
  ) {
    super(message);
    this.name = 'WhatIfError';
  }
}

// ===== Применение сценария =====

/** Что сценарий сделал с одним юрлицом. */
export interface WhatIfEntityChange {
  entityId: string;
  name: string;
  /** Номера месяцев 0..11, в которых выручка изменилась по условию сценария */
  months: number[];
  /** Выручка на машину в месяц; только у сценария «машины» */
  perCar: Dec | null;
  /** Добавочная выручка в месяц (N × на машину); только у сценария «машины» */
  perMonth: Dec | null;
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

function checkRequest(r: WhatIfRequest): void {
  switch (r.kind) {
    case 'cars':
      if (!Number.isInteger(r.cars) || r.cars < 1 || r.cars > WHATIF_MAX_CARS) {
        throw new WhatIfError(`Число машин должно быть от 1 до ${WHATIF_MAX_CARS}`, 'bad_input');
      }
      return;
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
 * Выручка идущего месяца по сценарию машин не меняется: машину покупают позже.
 */
export function applyWhatIf(data: CalcData, spec: WhatIfSpec): WhatIfApplied {
  checkRequest(spec.request);
  const { today } = data;
  const scope = new Set(pickEntities(spec.entityIds, data).map((e) => e.id));
  const req = spec.request;
  // машины считаются с ближайшего месяца, процент и сумма с идущего (прогнозные месяцы)
  const from = req.kind === 'cars' ? today.month + 1 : today.month;
  const months: number[] = [];
  for (let m = from; m <= 11; m++) months.push(m);
  const ctx = { weights: data.weights };

  const changes: WhatIfEntityChange[] = [];
  const entities = data.entities.map((e): EntityInput => {
    if (!scope.has(e.id)) return e;
    if (e.whatIf) throw new CalcInputError(`У юрлица ${e.name} уже задан сценарий`);

    let perCar: Dec | null = null;
    if (req.kind === 'cars') {
      perCar = e.revenuePerCarMonthly ?? null;
      if (perCar === null || perCar.lte(0)) {
        throw new WhatIfError(
          `У юрлица ${e.name} в справочнике не задана выручка на машину в месяц`,
          'no_car_revenue',
          e.id,
        );
      }
    }

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

    const parts: (WhatIfMonthPart | undefined)[] = new Array<WhatIfMonthPart | undefined>(12).fill(undefined);
    let delta = ZERO;
    const touched: number[] = [];
    for (let m = today.month; m <= 11; m++) {
      const base = monthAmount(e, ctx, m, today);
      let factor = dec(1);
      let extra = ZERO;
      if (m >= from) {
        if (req.kind === 'growth') factor = dec(1).plus(dec(req.percent).div(100));
        else if (req.kind === 'cars') extra = perCar!.times(req.cars);
        else extra = spread.get(m) ?? ZERO;
      }
      const amount = base.times(factor).plus(extra);
      if (amount.isNegative()) {
        throw new WhatIfError(`Выручка месяца у ${e.name} ушла бы ниже нуля`, 'bad_input', e.id);
      }
      parts[m] = { base, factor, extra };
      const change = amount.minus(base);
      if (!change.isZero()) {
        delta = delta.plus(change);
        touched.push(m);
      }
    }

    changes.push({
      entityId: e.id,
      name: e.name,
      months: touched,
      perCar,
      perMonth: req.kind === 'cars' ? perCar!.times(req.cars) : null,
      delta,
    });
    const whatIf: EntityWhatIf = { parts };
    // годовой прогноз сдвигается ровно на изменение: доходы без НДС, база порога и налог УСН
    // читают именно его
    return { ...e, annualRevenue: e.annualRevenue.plus(delta), whatIf };
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

const personCars = (n: number) => `${n} ${pluralRu(n, 'машину', 'машины', 'машин')}`;

/** Название сценария: «5 машин у ИП Дельта», «рост выручки на 20% у группы». */
function titleOf(spec: WhatIfSpec, names: string[], all: boolean): string {
  const who = all ? 'у группы' : `у ${names.join(' и ')}`;
  const r = spec.request;
  switch (r.kind) {
    case 'cars':
      return `${r.cars} ${pluralRu(r.cars, 'машина', 'машины', 'машин')} ${who}`;
    case 'growth':
      return `${r.percent >= 0 ? 'рост' : 'снижение'} выручки на ${numText(Math.abs(r.percent))}% ${who}`;
    case 'amount':
      return `${r.amount >= 0 ? 'рост' : 'снижение'} выручки на ${mln(Math.abs(r.amount), Math.abs(r.amount) % 100_000 === 0 ? 1 : 2)} ${who}`;
  }
}

function keyOf(spec: WhatIfSpec): string {
  const r = spec.request;
  const who = spec.entityIds === 'all' ? 'all' : [...spec.entityIds].sort().join('+');
  const what = r.kind === 'cars' ? `cars${r.cars}` : r.kind === 'growth' ? `g${r.percent}` : `a${r.amount}`;
  return `${what}@${who}`;
}

/** Допущения сценария одним списком: по ним панель расчёта, Excel и ответ агента. */
function assumptionsOf(spec: WhatIfSpec, applied: WhatIfApplied, year: number): string[] {
  const out: string[] = [];
  const r = spec.request;
  const months = monthRange(year, applied.months);
  if (r.kind === 'cars') {
    for (const c of applied.changes) {
      out.push(
        `${c.name}: выручка на машину в месяц ${rub(c.perCar!)} с НДС (демо-значение из справочника юрлица)`,
      );
      out.push(
        `${c.name}: добавочная выручка ${r.cars} × ${rub(c.perCar!)} = ${rub(c.perMonth!)} в месяц` +
          (months ? `, ${months}` : ', месяцев до конца года не осталось'),
      );
    }
    out.push('Цена машин и входной НДС по ним не учтены: доля закупок с НДС прежняя');
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
