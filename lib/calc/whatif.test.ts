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
  WhatIfError,
  applyWhatIf,
  compareWhatIf,
  vatStartLabel,
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
    ['5 машин у Дельты', spec({ kind: 'cars', cars: 5 }, ['delta'])],
    ['3 машины у Гаммы', spec({ kind: 'cars', cars: 3 }, ['gamma'])],
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
  it('добавочная выручка с ближайшего месяца: N × выручка на машину', () => {
    const applied = applyWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['delta']));
    const ch = applied.changes[0]!;
    expect(ch.perCar!.toString()).toBe('130000');
    expect(ch.perMonth!.toString()).toBe('650000');
    // сегодня октябрь: ближайший месяц ноябрь (10), потом декабрь
    expect(applied.from).toBe(10);
    expect(ch.months).toEqual([10, 11]);
    expect(ch.delta.toString()).toBe('1300000');
    const delta = applied.data.entities.find((e) => e.id === 'delta')!;
    const base = data.entities.find((e) => e.id === 'delta')!;
    expect(delta.annualRevenue.minus(base.annualRevenue).toString()).toBe('1300000');
    // октябрь без изменений, у остальных юрлиц данные те же объекты
    expect(delta.whatIf!.parts[9]!.extra.isZero()).toBe(true);
    expect(applied.data.entities.find((e) => e.id === 'alfa')).toBe(data.entities.find((e) => e.id === 'alfa'));
  });

  it('допущение выручки на машину названо в сравнении и в расчётах', () => {
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['delta']));
    const text = c.assumptions.join(' ').replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('130 000 ₽');
    expect(text).toContain('5 × 130 000 ₽ = 650 000 ₽ в месяц');
    expect(text).toContain('ноября по декабрь 2026');
    for (const r of c.scenario) expect(r.assumptions.join(' ')).toContain('выручка на машину');
    for (const r of c.base) expect(r.assumptions).toEqual([]);
    expect(c.scenario.every((r) => r.whatIf?.role === 'scenario')).toBe(true);
    expect(c.base.every((r) => r.whatIf?.role === 'base')).toBe(true);
  });

  it('без выручки на машину в справочнике сценарий не считается', () => {
    const noCar: CalcData = {
      ...data,
      entities: data.entities.map((e) => (e.id === 'beta' ? { ...e, revenuePerCarMonthly: null } : e)),
    };
    try {
      applyWhatIf(noCar, spec({ kind: 'cars', cars: 2 }, ['beta']));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WhatIfError);
      expect((e as WhatIfError).reason).toBe('no_car_revenue');
      expect((e as WhatIfError).entityId).toBe('beta');
    }
  });

  it('в декабре месяцев до конца года не остаётся: изменений нет', () => {
    const december = { ...data, today: moment(2026, 12, 5, 12, 0, 0) };
    const c = compareWhatIf(december, spec({ kind: 'cars', cars: 5 }, ['alfa']));
    expect(c.noChange).toBe(true);
    expect(c.months).toEqual([]);
  });

  it('числа вне границ отклоняются', () => {
    for (const bad of [0, -1, 1.5, 51]) {
      expect(() => applyWhatIf(data, spec({ kind: 'cars', cars: bad }, ['alfa']))).toThrow(WhatIfError);
    }
    expect(() => applyWhatIf(data, spec({ kind: 'growth', percent: -95 }, 'all'))).toThrow(WhatIfError);
    expect(() => applyWhatIf(data, spec({ kind: 'growth', percent: 600 }, 'all'))).toThrow(WhatIfError);
    expect(() => applyWhatIf(data, spec({ kind: 'cars', cars: 2 }, ['нет']))).toThrow();
  });
});

describe('порог освобождения: пересечение даёт НДС с правильного месяца', () => {
  it('сейчас Дельта пересекает порог 19 декабря, НДС с 1 января следующего года', () => {
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 1 }, ['delta']));
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
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['gamma']));
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
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['alfa']));
    const u = c.unified!;
    expect(u.signs).toBe('один бренд, один сайт, общий парк');
    expect(u.count).toBe(4);
    // Альфа 28,4 + Бета 22 + Дельта 20,9 + Гамма 6,4 = 77,7 млн
    expect(u.revenue.base!.toString()).toBe('77700000');
    // 5 машин × 180 000 ₽ × два месяца (ноябрь, декабрь)
    expect(u.revenue.scenario!.minus(u.revenue.base!).toString()).toBe('1800000');
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
    spec({ kind: 'cars', cars: 5 }, ['alfa']),
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
    const c = compareWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['alfa']));
    const vat = c.scenario.find((r) => r.tax === 'vat')!;
    const nov = vat.steps.find((s) => s.entityId === 'alfa' && s.month === '2026-11' && s.text.startsWith('по сценарию'))!;
    const text = nov.text.replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('по сценарию: прогноз месяца 1 420 000 ₽ + добавочная выручка 900 000 ₽ = 2 320 000 ₽');
    expect(nov.expression).toBe('1420000 * 1 + 900000');
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
    compareWhatIf(data, spec({ kind: 'cars', cars: 5 }, ['delta']));
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
