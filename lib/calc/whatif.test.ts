import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { dec, type Dec } from './decimal';
import { dashboardInput, calcTax, verifyCalcResult, type CalcData, type CalcResult } from './service';
import { computeLive, computeStatic } from './dashboard';
import { moment } from './time';
import {
  FLEET_DEFAULT_RENT_DAYS,
  WhatIfError,
  applyWhatIf,
  compareWhatIf,
  fleetLiveLine,
  fleetMissingMessages,
  fleetRevenuePerCar,
  fleetSoftWarnings,
  fleetUnitPrices,
  missingFleetFields,
  vatStartLabel,
  type CarsRequest,
  type FleetInput,
  type WhatIfEntityRow,
  type WhatIfRequest,
  type WhatIfSpec,
} from './whatif';

/** Фиксированный момент теста, как в CALC.md: 2026-10-10 12:00:00 */
const T = moment(2026, 10, 10, 12, 0, 0);
const YEAR = { kind: 'year', year: 2026 } as const;

let db: Db;
let close: () => Promise<void>;
let data: CalcData;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db, { tz: 'Asia/Kamchatka' });
  data = await loadCalcData(db, T);
});
afterAll(async () => close());

const spec = (request: WhatIfRequest, entityIds: string[] | 'all'): WhatIfSpec => ({ request, entityIds });
/** Парк из карточки: 3 млн с НДС, 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября. */
const FLEET: FleetInput = {
  cost: 3_000_000,
  costWithVat: true,
  rentPerDay: 8_000,
  rentDays: 20,
  startMonth: 10,
  expensesPerMonth: 0,
};
const cars = (n: number, fleet: Partial<FleetInput> = {}): WhatIfRequest => ({
  kind: 'cars',
  cars: n,
  fleet: { ...FLEET, ...fleet },
});
/** Выбранная ставка НДС юрлица в этом прогоне: подмена rate_choices на год сценария. */
const withRate = (d: CalcData, id: string, rate: 5 | 7 | 22): CalcData => ({
  ...d,
  choices: { ...d.choices, [d.today.year]: { ...(d.choices[d.today.year] ?? {}), [id]: rate } },
});
const row = (rows: WhatIfEntityRow[], id: string) => rows.find((r) => r.entityId === id)!;
const gte = (a: Dec | null, b: Dec | null) => {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.gte(b!), `${a!.toString()} >= ${b!.toString()}`).toBe(true);
};
const numbers = (r: CalcResult) => ({
  total: r.total?.toString() ?? null,
  revenue: r.revenue?.toString() ?? null,
  entities: r.entities.map((e) => [e.entityId, e.tax?.toString() ?? null, e.revenue?.toString() ?? null]),
  months: r.months.map((m) => [m.key, m.revenue?.toString() ?? null, m.tax?.toString() ?? null]),
});

describe('справочник: выручка на машину и вид деятельности', () => {
  it('поля пришли из базы вместе с юрлицами', () => {
    const by = Object.fromEntries(data.entities.map((e) => [e.id, e]));
    expect(by.alfa!.revenuePerCarMonthly!.toString()).toBe('180000');
    expect(by.delta!.revenuePerCarMonthly!.toString()).toBe('130000');
    expect(by.gamma!.activity).toBe('rent_with_crew');
    expect(by.alfa!.activity).toBe('rent_no_crew');
  });
});

describe('нулевое изменение равно базовому расчёту', () => {
  it('рост на 0% не заменяет данные и даёт те же числа', () => {
    const applied = applyWhatIf(data, spec({ kind: 'growth', percent: 0 }, 'all'));
    expect(applied.changed).toBe(false);
    expect(applied.data).toBe(data);
    const cmp = compareWhatIf(data, spec({ kind: 'growth', percent: 0 }, 'all'));
    expect(cmp.noChange).toBe(true);
    for (const r of cmp.rows) {
      expect(r.revenue.scenario!.toString()).toBe(r.revenue.base!.toString());
      expect(r.vat.scenario!.toString()).toBe(r.vat.base!.toString());
      expect(r.incomeTax.scenario!.toString()).toBe(r.incomeTax.base!.toString());
      if (r.threshold) {
        expect(r.threshold.scenario.crossing).toEqual(r.threshold.base.crossing);
      }
    }
    expect(cmp.totals.taxes.scenario!.toString()).toBe(cmp.totals.taxes.base!.toString());
  });

  it('нейтральные части сценария (рост 1, добавка 0) идут тем же расчётом, что данные', () => {
    // проверяется сам путь выручки по сценарию: он обязан быть нейтральным, когда изменений нет
    const ctx = { weights: data.weights };
    const neutral: CalcData = {
      ...data,
      entities: data.entities.map((e) => {
        const parts = new Array(12).fill(undefined) as NonNullable<typeof e.whatIf>['parts'];
        for (let m = data.today.month; m < 12; m++) {
          parts[m] = { base: e.annualRevenue.times(ctx.weights[m]!), factor: dec(1), extra: dec(0) };
        }
        return { ...e, whatIf: { parts } };
      }),
    };
    for (const tax of ['vat', 'usn', 'profit'] as const) {
      for (const period of [YEAR, { kind: 'ytd' } as const, { kind: 'quarter', year: 2026, quarter: 4 } as const]) {
        const a = calcTax({ entityIds: 'all', tax, period }, data);
        const b = calcTax({ entityIds: 'all', tax, period }, neutral);
        expect(numbers(b), `${tax} ${period.kind}`).toEqual(numbers(a));
        expect(verifyCalcResult(b), `${tax} ${period.kind}`).toEqual([]);
      }
    }
  });
});

describe('рост выручки не уменьшает налог', () => {
  const cases: [string, WhatIfSpec][] = [
    ['рост на 20% по группе', spec({ kind: 'growth', percent: 20 }, 'all')],
    ['рост на 20% по Альфе', spec({ kind: 'growth', percent: 20 }, ['alfa'])],
    ['рост на 20% по Бете', spec({ kind: 'growth', percent: 20 }, ['beta'])],
    ['рост на 20% по Эпсилон', spec({ kind: 'growth', percent: 20 }, ['epsilon'])],
    ['5 машин у Дельты', spec(cars(5), ['delta'])],
    ['3 машины у Гаммы', spec(cars(3), ['gamma'])],
    ['рост на 3 млн у Дельты', spec({ kind: 'amount', amount: 3_000_000 }, ['delta'])],
  ];
  for (const [name, s] of cases) {
    it(name, () => {
      const c = compareWhatIf(data, s);
      expect(c.noChange).toBe(false);
      for (const r of c.rows) {
        gte(r.revenue.scenario, r.revenue.base);
        gte(r.vat.scenario, r.vat.base);
        gte(r.incomeTax.scenario, r.incomeTax.base);
        gte(r.taxes.scenario, r.taxes.base);
      }
      gte(c.totals.taxes.scenario, c.totals.taxes.base);
    });
  }

  it('падение выручки на 10% не увеличивает налог', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: -10 }, 'all'));
    for (const r of c.rows) {
      gte(r.revenue.base, r.revenue.scenario);
      gte(r.taxes.base, r.taxes.scenario);
    }
    expect(c.totals.taxes.scenario!.lt(c.totals.taxes.base!)).toBe(true);
  });
});

describe('рост на 20%: числа из тех же формул', () => {
  it('НДС Альфы вырос на 5/105 добавочной выручки прогнозных месяцев', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: 20 }, ['alfa']));
    const alfa = row(c.rows, 'alfa');
    // прогнозные месяцы октябрь, ноябрь, декабрь: 28,4 млн × (0,06 + 0,05 + 0,11) × 20%
    const extra = dec(28_400_000).times('0.22').times('0.2');
    expect(alfa.revenue.scenario!.minus(alfa.revenue.base!).minus(extra).abs().lte('0.05')).toBe(true);
    const extraVat = extra.times(5).div(105);
    expect(alfa.vat.scenario!.minus(alfa.vat.base!).minus(extraVat).abs().lte('0.05')).toBe(true);
    // УСН «доходы» 6%: налог растёт на 6% добавочных доходов без НДС (выручка × 100 / 105)
    const extraUsn = extra.times(100).div(105).times('0.06');
    expect(alfa.incomeTax.scenario!.minus(alfa.incomeTax.base!).minus(extraUsn).abs().lte('0.05')).toBe(true);
    // доля лимита ставки 5% вырастает на добавку / 272,5 млн
    expect(alfa.limit5!.scenario.gt(alfa.limit5!.base)).toBe(true);
    expect(alfa.threshold).toBeNull();
  });

  it('у Эпсилон налог на прибыль, у Беты УСН «доходы минус расходы»', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: 20 }, 'all'));
    expect(row(c.rows, 'epsilon').incomeTaxKind).toBe('profit');
    expect(row(c.rows, 'beta').incomeTaxKind).toBe('usn');
    // Бета: расходы не меняются, весь прирост доходов попадает в базу
    const beta = row(c.rows, 'beta');
    const extra = dec(22_000_000).times('0.22').times('0.2').times(100).div(105).times('0.15');
    expect(beta.incomeTax.scenario!.minus(beta.incomeTax.base!).minus(extra).abs().lte('0.05')).toBe(true);
  });

  it('итоги группы равны сумме юрлиц и тем числам, что на дашборде', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: 20 }, 'all'));
    const sum = (pick: (r: WhatIfEntityRow) => Dec | null) =>
      c.rows.reduce((a, r) => a.plus(pick(r) ?? 0), dec(0));
    expect(c.totals.vat.base!.toString()).toBe(sum((r) => r.vat.base).toString());
    expect(c.totals.taxes.scenario!.toString()).toBe(sum((r) => r.taxes.scenario).toString());
    // «сейчас» совпадает с прогнозом НДС года на дашборде
    const input = dashboardInput(data);
    const stat = computeStatic(input, T);
    expect(c.totals.vat.base!.toString()).toBe(stat.forecastGroup.toString());
    expect(c.totals.incomeTax.base!.toString()).toBe(stat.incomeTaxGroup.total.toString());
  });
});

describe('сценарий «машины»', () => {
  it('добавочная выручка с выбранного месяца: N × цена сдачи в сутки × дни', () => {
    const applied = applyWhatIf(data, spec(cars(5), ['delta']));
    const ch = applied.changes[0]!;
    // 8 000 ₽ в сутки × 20 дней = 160 000 ₽ на машину, × 5 машин = 800 000 ₽ в месяц
    expect(ch.perCar!.toString()).toBe('160000');
    expect(ch.perMonth!.toString()).toBe('800000');
    expect(applied.from).toBe(10);
    expect(ch.months).toEqual([10, 11]);
    expect(ch.delta.toString()).toBe('1600000');
    const delta = applied.data.entities.find((e) => e.id === 'delta')!;
    const base = data.entities.find((e) => e.id === 'delta')!;
    expect(delta.annualRevenue.minus(base.annualRevenue).toString()).toBe('1600000');
    // октябрь без изменений, у остальных юрлиц данные те же объекты
    expect(delta.whatIf!.parts[9]!.extra.isZero()).toBe(true);
    expect(applied.data.entities.find((e) => e.id === 'alfa')).toBe(data.entities.find((e) => e.id === 'alfa'));
  });

  it('месяц начала сдачи выбирает человек: с декабря добавка только в декабре', () => {
    const ch = applyWhatIf(data, spec(cars(5, { startMonth: 11 }), ['alfa'])).changes[0]!;
    expect(ch.months).toEqual([11]);
    expect(ch.delta.toString()).toBe('800000');
  });

  it('выручка на машину не берётся из справочника юрлица', () => {
    // у юрлица в справочнике 130 000 ₽, но считается цена сдачи из карточки
    const delta = data.entities.find((e) => e.id === 'delta')!;
    expect(delta.revenuePerCarMonthly!.toString()).toBe('130000');
    const ch = applyWhatIf(data, spec(cars(1, { rentPerDay: 5_000, rentDays: 10 }), ['delta'])).changes[0]!;
    expect(ch.perCar!.toString()).toBe('50000');
  });

  it('значения из карточки названы в допущениях сравнения и в расчётах', () => {
    const c = compareWhatIf(data, spec(cars(5), ['delta']));
    const text = c.assumptions.join(' ').replace(/[  ]/g, ' ');
    expect(text).toContain('выручка на машину в месяц 160 000 ₽ с НДС = цена сдачи 8 000 ₽ в сутки × 20 дней');
    expect(text).toContain('добавочная выручка 5 × 160 000 ₽ = 800 000 ₽ в месяц');
    expect(text).toContain('ноября по декабрь 2026');
    expect(text).not.toContain('демо-значение');
    for (const r of c.scenario) expect(r.assumptions.join(' ')).toContain('выручка на машину');
    for (const r of c.base) expect(r.assumptions).toEqual([]);
    expect(c.scenario.every((r) => r.whatIf?.role === 'scenario')).toBe(true);
    expect(c.base.every((r) => r.whatIf?.role === 'base')).toBe(true);
  });

  it('принятые значения одной строкой', () => {
    const c = compareWhatIf(data, spec(cars(5), ['delta']));
    expect(c.fleet!.lines.values.replace(/[  ]/g, ' ')).toBe(
      '5 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября',
    );
    const net = compareWhatIf(data, spec(cars(2, { costWithVat: false, expensesPerMonth: 15_000 }), ['delta']));
    expect(net.fleet!.lines.values.replace(/[  ]/g, ' ')).toBe(
      '2 машины по 3 000 000 ₽ без НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября, расходы 15 000 ₽ в месяц на машину',
    );
  });

  it('в декабре месяцев до конца года не остаётся: изменений нет', () => {
    const december = { ...data, today: moment(2026, 12, 5, 12, 0, 0) };
    const c = compareWhatIf(december, spec(cars(5), ['alfa']));
    expect(c.noChange).toBe(true);
    expect(c.months).toEqual([]);
  });

  it('числа вне границ отклоняются', () => {
    for (const bad of [0, -1, 1.5, 51]) {
      expect(() => applyWhatIf(data, spec(cars(bad), ['alfa']))).toThrow(WhatIfError);
    }
    const bads: Partial<FleetInput>[] = [
      { cost: 0 },
      { cost: -5 },
      { rentPerDay: 0 },
      { rentDays: 0 },
      { rentDays: 32 },
      { rentDays: 2.5 },
      { expensesPerMonth: -1 },
      // сдача не может начаться в идущем или прошедшем месяце
      { startMonth: 9 },
      { startMonth: 12 },
    ];
    for (const f of bads) {
      expect(() => applyWhatIf(data, spec(cars(2, f), ['alfa'])), JSON.stringify(f)).toThrow(WhatIfError);
    }
    expect(() => applyWhatIf(data, spec({ kind: 'growth', percent: -95 }, 'all'))).toThrow(WhatIfError);
    expect(() => applyWhatIf(data, spec({ kind: 'growth', percent: 600 }, 'all'))).toThrow(WhatIfError);
    expect(() => applyWhatIf(data, spec(cars(2), ['нет']))).toThrow();
    // машины относятся к одному юрлицу
    expect(() => applyWhatIf(data, spec(cars(2), ['alfa', 'beta']))).toThrow(WhatIfError);
  });
});

describe('сценарий «машины» без обязательных полей не считается', () => {
  const full = FLEET;
  const required: (keyof FleetInput)[] = ['cost', 'costWithVat', 'rentPerDay', 'rentDays', 'startMonth'];
  for (const field of required) {
    it(`нет поля ${field}`, () => {
      const fleet: Partial<FleetInput> = { ...full };
      delete fleet[field];
      const request: WhatIfRequest = { kind: 'cars', cars: 5, fleet };
      expect(missingFleetFields(request as never)).toEqual([field]);
      for (const run of [() => applyWhatIf(data, spec(request, ['delta'])), () => compareWhatIf(data, spec(request, ['delta']))]) {
        try {
          run();
          expect.unreachable();
        } catch (e) {
          expect(e).toBeInstanceOf(WhatIfError);
          expect((e as WhatIfError).reason).toBe('missing_fields');
          expect((e as WhatIfError).fields).toEqual([field]);
        }
      }
    });
  }

  it('нет ни числа машин, ни значений: названы все недостающие поля', () => {
    const request: WhatIfRequest = { kind: 'cars', cars: null };
    expect(missingFleetFields(request as never)).toEqual([
      'cars',
      'cost',
      'costWithVat',
      'rentPerDay',
      'rentDays',
      'startMonth',
    ]);
    expect(() => compareWhatIf(data, spec(request, ['delta']))).toThrow(WhatIfError);
  });

  it('расходы необязательны: без них сценарий считается', () => {
    const fleet: Partial<FleetInput> = { ...FLEET };
    delete fleet.expensesPerMonth;
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 2, fleet }, ['alfa']));
    expect(c.noChange).toBe(false);
    expect(c.fleet!.effect.expensesTotal.isZero()).toBe(true);
  });

  it('значение по умолчанию для дней сдачи 20', () => {
    expect(FLEET_DEFAULT_RENT_DAYS).toBe(20);
  });

  it('выручка на машину в месяц это цена в сутки × дни', () => {
    expect(fleetRevenuePerCar(8000, 20).toString()).toBe('160000');
    expect(fleetRevenuePerCar('9500', 15).toString()).toBe('142500');
  });
});

describe('входной НДС по машинам', () => {
  // 5 машин по 3 млн с НДС: входной НДС 5 × 3 000 000 × 22 / 122
  const inputVat = dec(15_000_000).times(22).div(122);
  const extra = dec(800_000).times(2);

  it('ставка 22% с вычетами: входной НДС уменьшает НДС к уплате', () => {
    // Эпсилон на ОСНО: ставка 22% с вычетами, выбора нет
    const c = compareWhatIf(data, spec(cars(5), ['epsilon']));
    const e = row(c.rows, 'epsilon');
    const p = data.entities.find((x) => x.id === 'epsilon')!.inputVatShare;
    const grown = extra.times(22).div(122).times(dec(1).minus(p));
    // НДС сценария = НДС «сейчас» + НДС с добавочной выручки − входной НДС по машинам
    const want = e.vat.base!.plus(grown).minus(inputVat);
    expect(e.vat.scenario!.minus(want).abs().lte('0.05')).toBe(true);
    expect(e.vat.scenario!.lt(e.vat.base!)).toBe(true);
    expect(c.fleet!.effect.deduction).toBe('applied');
    expect(c.fleet!.effect.deducted.minus(inputVat).abs().lte('0.0001')).toBe(true);
    expect(c.fleet!.lines.deduction.replace(/[  ]/g, ' ')).toContain(
      'Входной НДС по машинам 2 704 918 ₽ (5 × 3 000 000 ₽ × 22 / 122) принят к вычету в ноябре',
    );
  });

  it('вычет берётся в месяце начала сдачи и записан шагом формулы', () => {
    const c = compareWhatIf(data, spec(cars(5), ['epsilon']));
    const vat = c.scenario.find((r) => r.tax === 'vat')!;
    const months = vat.entities.find((e) => e.entityId === 'epsilon')!.months;
    const nov = months.find((m) => m.key === '2026-11')!;
    const dec12 = months.find((m) => m.key === '2026-12')!;
    const stepOf = (id: string | null) => vat.steps.find((s) => s.id === id)!;
    expect(stepOf(nov.taxStep).text.replace(/[  ]/g, ' ')).toContain('входной НДС по машинам 2 704 918,03 ₽');
    expect(stepOf(nov.taxStep).expression).toMatch(/ - 2704918\.03/);
    expect(stepOf(dec12.taxStep).text).not.toContain('входной НДС по машинам');
    expect(verifyCalcResult(vat)).toEqual([]);
  });

  it('стоимость без НДС: вычет 22% от стоимости', () => {
    const c = compareWhatIf(data, spec(cars(5, { costWithVat: false }), ['epsilon']));
    expect(c.fleet!.effect.inputVat.toString()).toBe(dec(15_000_000).times(22).div(100).toString());
    expect(c.fleet!.lines.deduction.replace(/[  ]/g, ' ')).toContain('(5 × 3 000 000 ₽ × 22%)');
  });

  it('ставка 5%: вычета нет, НДС не зависит от стоимости машины', () => {
    const cheap = compareWhatIf(data, spec(cars(5, { cost: 1_000_000 }), ['alfa']));
    const dear = compareWhatIf(data, spec(cars(5, { cost: 9_000_000 }), ['alfa']));
    const a = row(cheap.rows, 'alfa');
    const b = row(dear.rows, 'alfa');
    expect(a.vat.scenario!.toString()).toBe(b.vat.scenario!.toString());
    // налог растёт ровно на 5 / 105 добавочной выручки
    const grown = extra.times(5).div(105);
    expect(a.vat.scenario!.minus(a.vat.base!).minus(grown).abs().lte('0.05')).toBe(true);
    expect(cheap.fleet!.effect.deduction).toBe('low_rate');
    expect(cheap.fleet!.effect.deducted.isZero()).toBe(true);
    expect(cheap.fleet!.lines.deduction).toContain('Вычета входного НДС по машинам нет');
    expect(cheap.fleet!.lines.deduction).toContain('ставка 5%');
  });

  it('ставка 7%: вычета нет', () => {
    const c = compareWhatIf(withRate(data, 'beta', 7), spec(cars(5), ['beta']));
    expect(c.fleet!.effect.deduction).toBe('low_rate');
    const r = row(c.rows, 'beta');
    const grown = extra.times(7).div(107);
    expect(r.vat.scenario!.minus(r.vat.base!).minus(grown).abs().lte('0.05')).toBe(true);
  });

  it('освобождённое юрлицо: вычета нет, НДС за год не уменьшается', () => {
    for (const id of ['delta', 'gamma']) {
      const c = compareWhatIf(withRate(data, id, 22), spec(cars(5), [id]));
      expect(c.fleet!.effect.deduction, id).toBe('exempt');
      expect(c.fleet!.effect.deducted.isZero()).toBe(true);
      expect(c.fleet!.lines.deduction).toContain('освобождение от НДС');
      expect(row(c.rows, id).vat.scenario!.gte(row(c.rows, id).vat.base!), id).toBe(true);
    }
  });

  it('плательщик УСН на ставке 22%, выбранной в справочнике: вычет есть', () => {
    const c = compareWhatIf(withRate(data, 'alfa', 22), spec(cars(5), ['alfa']));
    expect(c.fleet!.effect.deduction).toBe('applied');
    const r = row(c.rows, 'alfa');
    expect(r.vat.scenario!.lt(r.vat.base!.plus(extra.times(22).div(122)))).toBe(true);
    for (const run of [...c.base, ...c.scenario]) expect(verifyCalcResult(run), run.taxName).toEqual([]);
  });

  it('вычет может увести НДС ниже нуля: это НДС к возмещению, формулы сходятся', () => {
    const c = compareWhatIf(data, spec(cars(20, { cost: 9_000_000 }), ['epsilon']));
    const r = row(c.rows, 'epsilon');
    expect(r.vat.scenario!.isNegative()).toBe(true);
    for (const run of [...c.base, ...c.scenario]) expect(verifyCalcResult(run), run.taxName).toEqual([]);
  });
});

describe('расходы на машину и налог по режиму', () => {
  it('УСН «доходы минус расходы»: расходы уменьшают налог', () => {
    const none = compareWhatIf(data, spec(cars(5), ['beta']));
    const spent = compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['beta']));
    const a = row(none.rows, 'beta').incomeTax.scenario!;
    const b = row(spent.rows, 'beta').incomeTax.scenario!;
    // расходы 5 × 20 000 × 2 месяца = 200 000 ₽ при ставке 15%
    expect(a.minus(b).minus(dec(200_000).times('0.15')).abs().lte('0.05')).toBe(true);
    expect(spent.fleet!.effect.expensesTotal.toString()).toBe('200000');
  });

  it('ОСНО: расходы уменьшают налог на прибыль на 25% расходов', () => {
    const none = compareWhatIf(data, spec(cars(5), ['epsilon']));
    const spent = compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['epsilon']));
    const a = row(none.rows, 'epsilon').incomeTax.scenario!;
    const b = row(spent.rows, 'epsilon').incomeTax.scenario!;
    expect(a.minus(b).minus(dec(200_000).times('0.25')).abs().lte('0.05')).toBe(true);
  });

  it('УСН «доходы»: расходы налог не меняют, ответ говорит об этом', () => {
    const none = compareWhatIf(data, spec(cars(5), ['alfa']));
    const spent = compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['alfa']));
    expect(row(spent.rows, 'alfa').incomeTax.scenario!.toString()).toBe(row(none.rows, 'alfa').incomeTax.scenario!.toString());
    expect(spent.fleet!.lines.expenses).toContain('налог по УСН «доходы» не уменьшают');
  });

  it('стоимость машины в расходы не включается: порядок списания не моделируется', () => {
    const cheap = compareWhatIf(data, spec(cars(5, { cost: 1_000_000 }), ['beta']));
    const dear = compareWhatIf(data, spec(cars(5, { cost: 9_000_000 }), ['beta']));
    expect(row(cheap.rows, 'beta').incomeTax.scenario!.toString()).toBe(row(dear.rows, 'beta').incomeTax.scenario!.toString());
    for (const id of ['beta', 'gamma', 'epsilon']) {
      const c = compareWhatIf(data, spec(cars(5), [id]));
      const t = c.fleet!.lines.notModeled!.replace(/[  ]/g, ' ');
      expect(t, id).toContain('этот эффект не учтён, нужен бухгалтер');
      expect(t, id).toContain('Стоимость машин 15 000 000 ₽');
    }
    // у УСН «доходы» стоимость машины налог не меняет: предупреждать не о чем
    expect(compareWhatIf(data, spec(cars(5), ['alfa'])).fleet!.lines.notModeled).toBeNull();
    expect(compareWhatIf(data, spec(cars(5), ['alfa'])).assumptions.join(' ')).not.toContain('нужен бухгалтер');
    expect(compareWhatIf(data, spec(cars(5), ['beta'])).assumptions.join(' ')).toContain('нужен бухгалтер');
  });
});

describe('окупаемость', () => {
  it('стоимость машины / (выручка на машину в месяц − расходы): совпадает с ручным расчётом', () => {
    // 3 000 000 / (8 000 × 20) = 18,75 месяца
    const a = compareWhatIf(data, spec(cars(5), ['alfa'])).fleet!.effect;
    expect(a.paybackMonths!.toString()).toBe('18.75');
    // 3 000 000 / (160 000 − 20 000) = 21,428...
    const b = compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['alfa'])).fleet!.effect;
    expect(b.paybackMonths!.minus(dec(3_000_000).div(140_000)).abs().lte('0.000001')).toBe(true);
    // не зависит от числа машин и юрлица
    const c = compareWhatIf(data, spec(cars(1, { expensesPerMonth: 20_000 }), ['epsilon'])).fleet!.effect;
    expect(c.paybackMonths!.toString()).toBe(b.paybackMonths!.toString());
  });

  it('текст: формула и результат с одним знаком', () => {
    const c = compareWhatIf(data, spec(cars(5), ['alfa']));
    expect(c.fleet!.lines.payback.replace(/[  ]/g, ' ')).toContain('Окупаемость: 3 000 000 ₽ / 160 000 ₽ = 18,8 мес.');
    const e = compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['alfa']));
    expect(e.fleet!.lines.payback.replace(/[  ]/g, ' ')).toContain(
      'Окупаемость: 3 000 000 ₽ / (160 000 ₽ − 20 000 ₽) = 3 000 000 ₽ / 140 000 ₽ = 21,4 мес.',
    );
  });

  it('расходы не меньше выручки: машина не окупается', () => {
    const c = compareWhatIf(data, spec(cars(2, { expensesPerMonth: 160_000 }), ['alfa']));
    expect(c.fleet!.effect.paybackMonths).toBeNull();
    expect(c.fleet!.lines.payback).toContain('Машина не окупается');
  });
});

describe('порог освобождения: пересечение даёт НДС с правильного месяца', () => {
  it('сейчас Дельта пересекает порог 19 декабря, НДС с 1 января следующего года', () => {
    const c = compareWhatIf(data, spec(cars(1), ['delta']));
    const t = row(c.rows, 'delta').threshold!;
    expect(t.base.crossing).toEqual({ year: 2026, month: 11, day: 19 });
    expect(t.base.vatFrom).toEqual({ year: 2027, month: 0 });
    expect(vatStartLabel(t.base, 2026)).toBe('1 января 2027');
  });

  it('рост на 3 млн: порог пересекается в ноябре, НДС начинается с 1 декабря', () => {
    const c = compareWhatIf(data, spec({ kind: 'amount', amount: 3_000_000 }, ['delta']));
    const r = row(c.rows, 'delta');
    const t = r.threshold!;
    expect(t.scenario.crossing!.month).toBe(10);
    expect(t.scenario.vatFrom).toEqual({ year: 2026, month: 11 });
    expect(vatStartLabel(t.scenario, 2026)).toBe('1 декабря');
    // НДС за год появился: только за декабрь, по выбранной ставке 5% с выручки декабря
    const vat = c.scenario.find((x) => x.tax === 'vat')!;
    const months = vat.entities.find((e) => e.entityId === 'delta')!.months;
    expect(months.map((m) => m.exempt)).toEqual([
      true, true, true, true, true, true, true, true, true, true, true, false,
    ]);
    const dec12 = months[11]!;
    expect(dec12.tax!.toString()).toBe(dec12.revenue!.times(5).div(105).toString());
    expect(r.vat.base!.isZero()).toBe(true);
    expect(r.vat.scenario!.gt(0)).toBe(true);
    // дата пересечения раньше базовой
    expect(t.scenario.crossing!.month).toBeLessThan(t.base.crossing!.month);
  });

  it('падение выручки сдвигает дату пересечения вправо, порог остаётся в декабре', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: -10 }, ['delta']));
    const t = row(c.rows, 'delta').threshold!;
    expect(t.scenario.crossing!.month).toBe(11);
    expect(t.scenario.crossing!.day).toBeGreaterThan(t.base.crossing!.day);
  });

  it('у Гаммы порог не пересекается ни до, ни после', () => {
    const c = compareWhatIf(data, spec(cars(5), ['gamma']));
    const t = row(c.rows, 'gamma').threshold!;
    expect(t.base.crossing).toBeNull();
    expect(t.scenario.crossing).toBeNull();
    expect(vatStartLabel(t.scenario, 2026)).toBeNull();
  });

  it('если порог уже пройден до сценария, месяц НДС не сдвигается назад', () => {
    // 1 декабря: Дельта уже пересекла порог 19 декабря? нет, ещё нет; проверяем сегодняшний день
    const late = { ...data, today: moment(2026, 12, 20, 12, 0, 0) };
    const c = compareWhatIf(late, spec({ kind: 'growth', percent: 20 }, ['delta']));
    const t = row(c.rows, 'delta').threshold!;
    expect(t.base.crossing!.month).toBe(11);
    expect(t.scenario.crossing!.month).toBe(11);
  });
});

describe('признаки единого бизнеса и доля лимита', () => {
  it('сумма выручки юрлиц на УСН и её доля от лимита ставки 5% по данным и по сценарию', () => {
    const c = compareWhatIf(data, spec(cars(5), ['alfa']));
    const u = c.unified!;
    expect(u.signs).toBe('один бренд, один сайт, общий парк');
    expect(u.count).toBe(4);
    // Альфа 28,4 + Бета 22 + Дельта 20,9 + Гамма 6,4 = 77,7 млн
    expect(u.revenue.base!.toString()).toBe('77700000');
    // 5 машин × 160 000 ₽ × два месяца (ноябрь, декабрь)
    expect(u.revenue.scenario!.minus(u.revenue.base!).toString()).toBe('1600000');
    expect(u.share.base!.times(100).toFixed(1)).toBe('28.5');
    expect(u.limit.toString()).toBe('272500000');
  });

  it('у юрлица на ОСНО признаков единого бизнеса нет', () => {
    const c = compareWhatIf(data, spec({ kind: 'growth', percent: 10 }, ['epsilon']));
    expect(c.unified).toBeNull();
  });
});

describe('расчёты сценария объяснены шагами', () => {
  const specs: WhatIfSpec[] = [
    spec(cars(5), ['alfa']),
    spec(cars(5, { expensesPerMonth: 25_000 }), ['beta']),
    spec(cars(5), ['epsilon']),
    spec({ kind: 'growth', percent: 20 }, 'all'),
    spec({ kind: 'growth', percent: -10 }, 'all'),
    spec({ kind: 'amount', amount: 3_000_000 }, ['delta']),
  ];
  for (const s of specs) {
    it(`${s.request.kind}: verifyCalcResult без нарушений`, () => {
      const c = compareWhatIf(data, s);
      for (const r of [...c.base, ...c.scenario]) expect(verifyCalcResult(r), r.taxName).toEqual([]);
    });
  }

  it('шаг выручки месяца называет сценарий и содержит выражение для проверки', () => {
    const c = compareWhatIf(data, spec(cars(5), ['alfa']));
    const vat = c.scenario.find((r) => r.tax === 'vat')!;
    const nov = vat.steps.find((s) => s.entityId === 'alfa' && s.month === '2026-11' && s.text.startsWith('по сценарию'))!;
    const text = nov.text.replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('по сценарию: прогноз месяца 1 420 000 ₽ + добавочная выручка 800 000 ₽ = 2 220 000 ₽');
    expect(nov.expression).toBe('1420000 * 1 + 800000');
    // октябрь по сценарию машин не меняется
    const oct = vat.steps.find((s) => s.entityId === 'alfa' && s.month === '2026-10' && s.text.startsWith('по сценарию'))!;
    expect(oct.text).toContain('без изменений');
  });
});

describe('сценарий не меняет данные дашборда', () => {
  it('юрлица и итоги дашборда после сценариев те же', () => {
    const input = dashboardInput(data);
    const before = JSON.stringify([
      data.entities.map((e) => [e.id, e.annualRevenue.toString(), e.whatIf ?? null]),
      computeStatic(input, T).forecastGroup.toString(),
      computeLive(input, T, computeStatic(input, T)).ytdGroup.toString(),
    ]);
    compareWhatIf(data, spec({ kind: 'growth', percent: 20 }, 'all'));
    compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['delta']));
    compareWhatIf(data, spec(cars(5, { expensesPerMonth: 20_000 }), ['epsilon']));
    compareWhatIf(data, spec(cars(5), ['beta']));
    compareWhatIf(data, spec({ kind: 'amount', amount: 3_000_000 }, ['delta']));
    const input2 = dashboardInput(data);
    const after = JSON.stringify([
      data.entities.map((e) => [e.id, e.annualRevenue.toString(), e.whatIf ?? null]),
      computeStatic(input2, T).forecastGroup.toString(),
      computeLive(input2, T, computeStatic(input2, T)).ytdGroup.toString(),
    ]);
    expect(after).toBe(before);
  });
});

describe('машины с разными ценами: расчёт по каждой машине', () => {
  /** Две машины: 3 млн и сдача 8 000, 5 млн и сдача 10 000 ₽ в сутки; 20 дней, с ноября */
  const two = (over: Partial<FleetInput> = {}): WhatIfRequest => ({
    kind: 'cars',
    cars: 2,
    fleet: {
      costWithVat: true,
      rentDays: 20,
      startMonth: 10,
      expensesPerMonth: 0,
      units: [
        { cost: 3_000_000, rentPerDay: 8_000 },
        { cost: 5_000_000, rentPerDay: 10_000 },
      ],
      ...over,
    },
  });
  const inputVat = dec(8_000_000).times(22).div(122);
  // 160 000 + 200 000 = 360 000 в месяц, ноябрь и декабрь
  const extra = dec(360_000).times(2);

  it('выручка, добавочная выручка и входной НДС считаются по каждой машине', () => {
    const c = compareWhatIf(data, spec(two(), ['epsilon']));
    const f = c.fleet!.effect;
    expect(f.uniform).toBe(false);
    expect(f.units.map((u) => u.perMonth.toString())).toEqual(['160000', '200000']);
    expect(f.units.map((u) => u.cost.toString())).toEqual(['3000000', '5000000']);
    expect(f.perMonth.toString()).toBe('360000');
    expect(f.totalCost.toString()).toBe('8000000');
    // входной НДС каждой машины: стоимость × 22 / 122
    expect(f.units[0]!.inputVat.minus(dec(3_000_000).times(22).div(122)).abs().lte('0.0001')).toBe(true);
    expect(f.units[1]!.inputVat.minus(dec(5_000_000).times(22).div(122)).abs().lte('0.0001')).toBe(true);
    expect(f.inputVat.minus(inputVat).abs().lte('0.0001')).toBe(true);
    expect(c.changes[0]!.perMonth!.toString()).toBe('360000');
    expect(c.changes[0]!.delta.toString()).toBe(extra.toString());
  });

  it('НДС юрлица на 22%: вычет суммы по обеим машинам, формулы сходятся', () => {
    const c = compareWhatIf(data, spec(two(), ['epsilon']));
    const e = row(c.rows, 'epsilon');
    const p = data.entities.find((x) => x.id === 'epsilon')!.inputVatShare;
    const want = e.vat.base!.plus(extra.times(22).div(122).times(dec(1).minus(p))).minus(inputVat);
    expect(e.vat.scenario!.minus(want).abs().lte('0.05')).toBe(true);
    expect(c.fleet!.effect.deduction).toBe('applied');
    for (const r of [...c.base, ...c.scenario]) expect(verifyCalcResult(r), r.taxName).toEqual([]);
    const text = c.fleet!.lines.deduction.replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('(3 000 000 ₽ + 5 000 000 ₽) × 22 / 122');
  });

  it('для 5%, 7% и освобождённых вычета нет, налог от стоимости не зависит', () => {
    const dear = two({ units: [{ cost: 9_000_000, rentPerDay: 8_000 }, { cost: 9_000_000, rentPerDay: 10_000 }] });
    for (const [d, id, why] of [
      [data, 'alfa', 'low_rate'],
      [withRate(data, 'beta', 7), 'beta', 'low_rate'],
      [data, 'delta', 'exempt'],
      [data, 'gamma', 'exempt'],
      [withRate(data, 'delta', 22), 'delta', 'exempt'],
    ] as const) {
      const a = compareWhatIf(d, spec(two(), [id]));
      const b = compareWhatIf(d, spec(dear, [id]));
      expect(a.fleet!.effect.deduction, id).toBe(why);
      expect(a.fleet!.effect.deducted.isZero(), id).toBe(true);
      expect(row(a.rows, id).vat.scenario!.toString(), id).toBe(row(b.rows, id).vat.scenario!.toString());
      expect(a.fleet!.lines.deduction, id).toContain('Вычета входного НДС по машинам нет');
    }
  });

  it('окупаемость каждой машины и всех вместе совпадает с ручным расчётом', () => {
    const f = compareWhatIf(data, spec(two(), ['alfa'])).fleet!.effect;
    expect(f.units[0]!.paybackMonths!.toString()).toBe('18.75'); // 3 000 000 / 160 000
    expect(f.units[1]!.paybackMonths!.toString()).toBe('25'); // 5 000 000 / 200 000
    expect(f.paybackMonths!.minus(dec(8_000_000).div(360_000)).abs().lte('0.000001')).toBe(true);
    // с расходами 20 000 на машину
    const g = compareWhatIf(data, spec(two({ expensesPerMonth: 20_000 }), ['alfa'])).fleet!.effect;
    expect(g.units[0]!.paybackMonths!.minus(dec(3_000_000).div(140_000)).abs().lte('0.000001')).toBe(true);
    expect(g.units[1]!.paybackMonths!.minus(dec(5_000_000).div(180_000)).abs().lte('0.000001')).toBe(true);
    expect(g.paybackMonths!.minus(dec(8_000_000).div(320_000)).abs().lte('0.000001')).toBe(true);
    expect(g.expensesTotal.toString()).toBe('80000'); // 2 машины × 20 000 × 2 месяца
  });

  it('одна машина не окупается, остальные да: общая окупаемость есть, лишнее названо', () => {
    const c = compareWhatIf(data, spec(two({ expensesPerMonth: 170_000 }), ['alfa']));
    const f = c.fleet!.effect;
    expect(f.units[0]!.paybackMonths).toBeNull();
    expect(f.units[1]!.paybackMonths!.gt(0)).toBe(true);
    expect(c.fleet!.lines.payback).toContain('не окупаются сами по себе: машина 1');
  });

  it('строка принятых значений называет каждую машину', () => {
    const c = compareWhatIf(data, spec(two(), ['delta']));
    expect(c.fleet!.lines.values.replace(/[\u00a0\u202f]/g, ' ')).toBe(
      '2 машины с НДС, сдача × 20 дней в месяц: машина 1 за 3 000 000 ₽, сдача 8 000 ₽ в сутки (160 000 ₽ в месяц); ' +
        'машина 2 за 5 000 000 ₽, сдача 10 000 ₽ в сутки (200 000 ₽ в месяц), с ноября',
    );
    // одинаковые цены в списке машин считаются одной ценой на всех, строка прежняя
    const same = compareWhatIf(
      data,
      spec(two({ units: [{ cost: 3_000_000, rentPerDay: 8_000 }, { cost: 3_000_000, rentPerDay: 8_000 }] }), ['delta']),
    );
    expect(same.fleet!.effect.uniform).toBe(true);
    expect(same.fleet!.lines.values.replace(/[\u00a0\u202f]/g, ' ')).toBe(
      '2 машины по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября',
    );
  });

  it('общая цена и свои цены вместе: «по 3 млн, вторая 5 млн»; «остальные такие же» берёт последнюю названную', () => {
    const mixed: CarsRequest = {
      kind: 'cars',
      cars: 3,
      fleet: { cost: 3_000_000, rentPerDay: 8_000, costWithVat: true, rentDays: 20, startMonth: 10, units: [{}, { cost: 5_000_000 }] },
    };
    expect(fleetUnitPrices(mixed).map((p) => p.cost)).toEqual([3_000_000, 5_000_000, 3_000_000]);
    const rest: CarsRequest = { kind: 'cars', cars: 4, fleet: { rentPerDay: 8_000, units: [{ cost: 3_000_000 }], rest: 'same' } };
    expect(fleetUnitPrices(rest).map((p) => p.cost)).toEqual([3_000_000, 3_000_000, 3_000_000, 3_000_000]);
    const noRest: CarsRequest = { kind: 'cars', cars: 4, fleet: { rentPerDay: 8_000, units: [{ cost: 3_000_000 }] } };
    expect(fleetUnitPrices(noRest).map((p) => p.cost)).toEqual([3_000_000, null, null, null]);
  });

  it('без цены какой-то машины не считается, сообщения называют номер машины', () => {
    const r: WhatIfRequest = {
      kind: 'cars',
      cars: 3,
      fleet: {
        costWithVat: true,
        rentDays: 20,
        startMonth: 10,
        units: [{ cost: 3_000_000, rentPerDay: 8_000 }, { cost: 5_000_000 }],
      },
    };
    expect(missingFleetFields(r as never)).toEqual(['cost', 'rentPerDay']);
    expect(fleetMissingMessages(r as never)).toEqual([
      'Укажите цену сдачи машины 2',
      'Укажите стоимость машины 3',
      'Укажите цену сдачи машины 3',
    ]);
    for (const run of [() => applyWhatIf(data, spec(r, ['delta'])), () => compareWhatIf(data, spec(r, ['delta']))]) {
      expect(run).toThrow(WhatIfError);
    }
  });

  it('цена машины не больше нуля называет машину; дни и месяц проверяются', () => {
    const bad = two({ units: [{ cost: 3_000_000, rentPerDay: 8_000 }, { cost: 0, rentPerDay: 10_000 }] });
    expect(() => applyWhatIf(data, spec(bad, ['alfa']))).toThrow(/Укажите стоимость машины 2/);
    const badRent = two({ units: [{ cost: 3_000_000, rentPerDay: -1 }, { cost: 5_000_000, rentPerDay: 10_000 }] });
    expect(() => applyWhatIf(data, spec(badRent, ['alfa']))).toThrow(/Укажите цену сдачи машины 1/);
    expect(() => applyWhatIf(data, spec(two({ rentDays: 0 }), ['alfa']))).toThrow(/от 1 до 31/);
    expect(() => applyWhatIf(data, spec(two({ rentDays: 32 }), ['alfa']))).toThrow(/от 1 до 31/);
    expect(() => applyWhatIf(data, spec(two({ startMonth: 9 }), ['alfa']))).toThrow(/не раньше следующего месяца/);
  });

  it('разные цены только до 10 машин; одна цена на всех до 50', () => {
    const eleven = (units: { cost: number; rentPerDay: number }[]): WhatIfRequest => ({
      kind: 'cars',
      cars: 11,
      fleet: { costWithVat: true, rentDays: 20, startMonth: 10, units },
    });
    const differ = Array.from({ length: 11 }, (_, i) => ({ cost: 3_000_000 + i * 100_000, rentPerDay: 8_000 }));
    expect(() => applyWhatIf(data, spec(eleven(differ), ['alfa']))).toThrow(/до 10 машин/);
    const ten = Array.from({ length: 10 }, (_, i) => ({ cost: 3_000_000 + i * 100_000, rentPerDay: 8_000 }));
    expect(() => applyWhatIf(data, spec({ ...eleven(ten), cars: 10 } as WhatIfRequest, ['alfa']))).not.toThrow();
    // одинаковые цены у 11 машин и одна цена на 50 считаются
    const same = Array.from({ length: 11 }, () => ({ cost: 3_000_000, rentPerDay: 8_000 }));
    expect(() => applyWhatIf(data, spec(eleven(same), ['alfa']))).not.toThrow();
    expect(compareWhatIf(data, spec(cars(50), ['epsilon'])).fleet!.effect.units).toHaveLength(50);
  });

  it('мягкие предупреждения не блокируют расчёт', () => {
    const odd = two({ units: [{ cost: 100_000, rentPerDay: 500 }, { cost: 40_000_000, rentPerDay: 150_000 }] });
    const c = compareWhatIf(data, spec(odd, ['alfa']));
    expect(c.noChange).toBe(false);
    const w = fleetSoftWarnings(fleetUnitPrices(odd as never)).map((x) => x.replace(/[\u00a0\u202f]/g, ' '));
    expect(w).toEqual([
      'Машина 1: стоимость 100 000 ₽ меньше 300 000 ₽, проверьте',
      'Машина 1: цена сдачи 500 ₽ в сутки меньше 1 000 ₽, проверьте',
      'Машина 2: стоимость 40 000 000 ₽ больше 30 000 000 ₽, проверьте',
      'Машина 2: цена сдачи 150 000 ₽ в сутки больше 100 000 ₽, проверьте',
    ]);
    // обычные значения и границы без предупреждений
    expect(fleetSoftWarnings([{ cost: 300_000, rentPerDay: 1_000 }, { cost: 30_000_000, rentPerDay: 100_000 }])).toEqual([]);
    expect(fleetSoftWarnings([{ cost: 299_999, rentPerDay: 5_000 }]).length).toBe(1);
  });

  it('живая строка итога под полями считается ядром', () => {
    const plain = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, ' ');
    expect(plain(fleetLiveLine(Array.from({ length: 5 }, () => ({ cost: 3_000_000, rentPerDay: 8_000 })), 20))).toBe(
      '5 машин × 3 000 000 ₽ = 15 000 000 ₽, выручка 800 000 ₽ в месяц',
    );
    expect(plain(fleetLiveLine([{ cost: 3_000_000, rentPerDay: 8_000 }, { cost: 5_000_000, rentPerDay: 10_000 }], 20))).toBe(
      'Всего 2 машины: 8 000 000 ₽, выручка 360 000 ₽ в месяц',
    );
    // не всё названо: показано только посчитанное
    expect(plain(fleetLiveLine([{ cost: 3_000_000, rentPerDay: null }, { cost: 3_000_000, rentPerDay: null }], 20))).toBe(
      '2 машины × 3 000 000 ₽ = 6 000 000 ₽',
    );
    expect(plain(fleetLiveLine([{ cost: null, rentPerDay: 8_000 }], 20))).toBe('выручка 160 000 ₽ в месяц');
    expect(fleetLiveLine([{ cost: null, rentPerDay: null }], 20)).toBeNull();
    expect(plain(fleetLiveLine([{ cost: 1, rentPerDay: 1 }], 0))).toBe('1 машина × 1 ₽ = 1 ₽');
  });

  it('разные цены не меняют данные дашборда', () => {
    const input = dashboardInput(data);
    const before = JSON.stringify([
      data.entities.map((e) => [e.id, e.annualRevenue.toString(), e.annualExpenses.toString(), e.whatIf ?? null]),
      computeStatic(input, T).forecastGroup.toString(),
      computeLive(input, T, computeStatic(input, T)).ytdGroup.toString(),
    ]);
    compareWhatIf(data, spec(two({ expensesPerMonth: 15_000 }), ['epsilon']));
    compareWhatIf(data, spec(two(), ['beta']));
    const input2 = dashboardInput(data);
    const after = JSON.stringify([
      data.entities.map((e) => [e.id, e.annualRevenue.toString(), e.annualExpenses.toString(), e.whatIf ?? null]),
      computeStatic(input2, T).forecastGroup.toString(),
      computeLive(input2, T, computeStatic(input2, T)).ytdGroup.toString(),
    ]);
    expect(after).toBe(before);
  });

  it('другой набор цен это другой сценарий: ключи отметок «сверил» разные', () => {
    const a = compareWhatIf(data, spec(two(), ['alfa'])).key;
    const b = compareWhatIf(data, spec(two({ units: [{ cost: 3_000_000, rentPerDay: 8_000 }, { cost: 5_000_000, rentPerDay: 11_000 }] }), ['alfa'])).key;
    expect(a).not.toBe(b);
  });
});
