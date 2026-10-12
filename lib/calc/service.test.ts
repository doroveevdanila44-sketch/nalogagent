import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwner } from '@/lib/auth/service';
import type { Db } from '@/lib/db/client';
import { loadCalcData, saveRateChoice } from '@/lib/db/queries';
import { users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { SEED_RULE_ROWS } from './demo-data';
import { D, ZERO, dec, round2, sum, type Dec } from './decimal';
import type { Period } from './period';
import { moneyText } from './provenance';
import { MissingRuleError } from './rules';
import {
  buildCalcData,
  calcTax,
  CalcInputError,
  dashboardInput,
  compareRates,
  dataKind,
  verifyCalcResult,
  type CalcData,
  type CalcResult,
  type CalcTaxArgs,
  type TaxKind,
} from './service';
import { moment } from './time';

/** Фиксированный момент теста, как в CALC.md: 2026-10-10 12:00:00 */
const T = moment(2026, 10, 10, 12, 0, 0);

let db: Db;
let close: () => Promise<void>;
let data: CalcData;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db, { tz: 'Asia/Kamchatka' });
  data = await loadCalcData(db, T);
});
afterAll(async () => close());

const calc = (args: Omit<CalcTaxArgs, 'entityIds'> & { entityIds?: CalcTaxArgs['entityIds'] }, d = data): CalcResult =>
  calcTax({ entityIds: 'all', ...args }, d);

const near = (actual: Dec | null, expected: number, tol = 1) => {
  expect(actual, 'значение есть').not.toBeNull();
  expect(Math.abs(actual!.toNumber() - expected)).toBeLessThanOrEqual(tol);
};

const ent = (r: CalcResult, id: string) => r.entities.find((e) => e.entityId === id)!;
const plain = (s: string) => s.replace(/[  ]/g, ' ');

/** Копия снимка с изменённой помесячной выручкой. */
function withRevenue(base: CalcData, edit: (rows: CalcData['revenue']) => CalcData['revenue']): CalcData {
  return buildCalcData({
    today: base.today,
    entities: base.entities.map(({ monthly: _m, ...e }) => e),
    weights: base.weights,
    ruleRows: base.ruleRows,
    choices: base.choices,
    revenue: edit(base.revenue.map((r) => ({ ...r }))),
    source: base.source,
  });
}

describe('снимок из базы', () => {
  it('юрлица, выручка двух лет и один источник', () => {
    expect(data.entities.map((e) => e.id)).toEqual(['alfa', 'beta', 'delta', 'gamma', 'epsilon']);
    expect(data.revenue).toHaveLength(5 * 24);
    expect(new Set(data.revenue.map((r) => r.sourceId))).toEqual(new Set(['demo-1c']));
    expect(data.source).toMatchObject({ id: 'demo-1c', kind: 'demo_1c', title: 'Выгрузка из 1С (демо)', isDemo: true });
    // для калькулятора в monthly лежат только строки года «сегодня»
    expect(data.entities[0]!.monthly).toHaveLength(12);
  });
});

describe('контрольные числа CALC.md не изменились', () => {
  it('НДС до конца 2026 при выбранных ставках: Альфа, Бета, Дельта 0, Гамма 0, Эпсилон', () => {
    const r = calc({ tax: 'vat', period: { kind: 'year', year: 2026 } });
    near(ent(r, 'alfa').tax, 1_352_381);
    near(ent(r, 'beta').tax, 1_047_619);
    expect(ent(r, 'delta').tax!.isZero()).toBe(true);
    expect(ent(r, 'gamma').tax!.isZero()).toBe(true);
    near(ent(r, 'epsilon').tax, 6_004_918);
    // Альфа 5%: 28 400 000 × 5 / 105
    expect(ent(r, 'alfa').tax!.toString()).toBe(round2(dec(28_400_000).times(5).div(105)).toString());
  });

  it('НДС по трём ставкам для плательщиков (таблица CALC.md)', () => {
    const at = (rate: 5 | 7 | 22) => calc({ tax: 'vat', rate, period: { kind: 'year', year: 2026 } });
    near(ent(at(5), 'alfa').tax, 1_352_381);
    near(ent(at(7), 'alfa').tax, 1_857_944);
    near(ent(at(22), 'alfa').tax, 921_836);
    near(ent(at(5), 'beta').tax, 1_047_619);
    near(ent(at(7), 'beta').tax, 1_439_252);
    near(ent(at(22), 'beta').tax, 2_618_361);
    // Эпсилон на ОСНО: ставка одна, общая с вычетами
    near(ent(at(5), 'epsilon').tax, 6_004_918);
    expect(ent(at(5), 'epsilon').rate).toBe(22);
  });

  it('накопленная выручка с начала года на дату теста', () => {
    const r = calc({ tax: 'vat', period: { kind: 'ytd' } });
    near(ent(r, 'alfa').revenue, 22_674_194);
    near(ent(r, 'beta').revenue, 17_564_516);
    near(ent(r, 'delta').revenue, 16_686_290);
    near(ent(r, 'gamma').revenue, 5_109_677);
  });

  it('НДС Эпсилон начислен на дату: 4 794 249', () => {
    near(ent(calc({ tax: 'vat', period: { kind: 'ytd' } }), 'epsilon').tax, 4_794_249);
  });

  it('УСН за год и начислено на дату', () => {
    const year = calc({ tax: 'usn', period: { kind: 'year', year: 2026 } });
    near(ent(year, 'alfa').tax, 1_622_857);
    near(ent(year, 'beta').tax, 832_857);
    near(ent(year, 'delta').tax, 1_254_000);
    near(ent(year, 'gamma').tax, 180_000);
    const now = calc({ tax: 'usn', period: { kind: 'ytd' } });
    near(ent(now, 'alfa').tax, 1_295_668);
    near(ent(now, 'beta').tax, 664_942);
    near(ent(now, 'delta').tax, 1_001_177);
    near(ent(now, 'gamma').tax, 143_710);
  });

  it('налог на прибыль Эпсилон: 4 163 934 за год, 3 324 432 на дату', () => {
    near(ent(calc({ tax: 'profit', period: { kind: 'year', year: 2026 } }), 'epsilon').tax, 4_163_934);
    near(ent(calc({ tax: 'profit', period: { kind: 'ytd' } }), 'epsilon').tax, 3_324_432);
  });

  it('авансы 28.10 за 9 месяцев: УСН 1 439 194, налог на прибыль 1 540 656', () => {
    const q3 = calc({ tax: 'usn', period: { kind: 'quarter', year: 2026, quarter: 3 } });
    near(ent(q3, 'alfa').tax, 600_457);
    near(ent(q3, 'beta').tax, 308_157);
    near(ent(q3, 'delta').tax, 463_980);
    near(ent(q3, 'gamma').tax, 66_600);
    near(q3.total, 1_439_194);
    const profit = calc({ tax: 'profit', period: { kind: 'quarter', year: 2026, quarter: 3 } });
    near(ent(profit, 'epsilon').tax, 1_540_656);
  });

  it('первая треть НДС за 3 квартал: Альфа 166 794, Бета 129 206, Эпсилон 740 607', () => {
    const q3 = calc({ tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 3 } });
    near(ent(q3, 'alfa').tax!.div(3), 166_794);
    near(ent(q3, 'beta').tax!.div(3), 129_206);
    near(ent(q3, 'epsilon').tax!.div(3), 740_607);
    near(sum([ent(q3, 'alfa').tax!, ent(q3, 'beta').tax!, ent(q3, 'epsilon').tax!]).div(3), 1_036_607);
  });

  it('УСН при ставке НДС 22%: Альфа 1 396 721, Бета 394 918', () => {
    const r = calc({ tax: 'usn', rate: 22, period: { kind: 'year', year: 2026 } });
    near(ent(r, 'alfa').tax, 1_396_721);
    near(ent(r, 'beta').tax, 394_918);
  });

  it('минимальный налог: при расходах Беты 20 800 000 платится 1% доходов', () => {
    const rich = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) =>
        e.id === 'beta' ? { ...e, annualExpenses: dec(20_800_000) } : e,
      ),
      weights: data.weights,
      ruleRows: data.ruleRows,
      choices: data.choices,
      revenue: data.revenue,
      source: data.source,
    });
    const r = calc({ entityIds: ['beta'], tax: 'usn', period: { kind: 'year', year: 2026 } }, rich);
    near(ent(r, 'beta').tax, 209_523.81, 0.01);
    expect(r.steps.some((s) => s.expression.startsWith('max(s') && /минимальный|большее/.test(s.text))).toBe(true);
  });
});

describe('сумма по месяцам равна итогу за квартал и за год', () => {
  const taxes: TaxKind[] = ['vat', 'usn', 'profit'];
  const monthsOf = (year: number): Period[] =>
    Array.from({ length: 12 }, (_, i) => ({ kind: 'month', year, month: i + 1 }));

  for (const tax of taxes) {
    it(`${tax}: внутри результата месяцы дают налог юрлица, юрлица дают итог`, () => {
      for (const period of [
        { kind: 'quarter', year: 2026, quarter: 2 },
        { kind: 'year', year: 2026 },
        { kind: 'ytd' },
      ] as Period[]) {
        const r = calc({ tax, period });
        for (const e of r.entities.filter((x) => x.applicable)) {
          const months = sum(e.months.map((m) => m.tax!));
          expect(round2(months).eq(e.tax!), `${e.entityId} ${r.periodLabel}`).toBe(true);
        }
        const used = r.entities.filter((x) => x.applicable);
        expect(sum(used.map((e) => e.tax!)).eq(r.total!)).toBe(true);
        // итоги по месяцам группы расходятся с округлённым итогом не больше чем на полкопейки на юрлицо
        const byMonth = sum(r.months.map((m) => m.tax!));
        expect(byMonth.minus(r.total!).abs().toNumber()).toBeLessThan(0.005 * used.length + 1e-9);
      }
    });

    it(`${tax}: четыре квартала и двенадцать месяцев дают год`, () => {
      const year = calc({ tax, period: { kind: 'year', year: 2026 } });
      const quarters = [1, 2, 3, 4].map((q) => calc({ tax, period: { kind: 'quarter', year: 2026, quarter: q } }));
      const months = monthsOf(2026).map((period) => calc({ tax, period }));

      for (const e of year.entities.filter((x) => x.applicable)) {
        // точные значения месяцев одинаковы в любом периоде
        const exactYear = sum(e.months.map((m) => m.tax!));
        const exactQuarters = sum(quarters.flatMap((q) => ent(q, e.entityId).months.map((m) => m.tax!)));
        const exactMonths = sum(months.flatMap((m) => ent(m, e.entityId).months.map((x) => x.tax!)));
        expect(exactQuarters.minus(exactYear).abs().toNumber()).toBeLessThan(1e-9);
        expect(exactMonths.minus(exactYear).abs().toNumber()).toBeLessThan(1e-9);

        // округлённые итоги расходятся не больше чем на копейку за округление каждого периода
        const roundedQuarters = sum(quarters.map((q) => ent(q, e.entityId).tax!));
        expect(roundedQuarters.minus(e.tax!).abs().toNumber()).toBeLessThanOrEqual(0.02 + 1e-9);
        const roundedMonths = sum(months.map((m) => ent(m, e.entityId).tax!));
        expect(roundedMonths.minus(e.tax!).abs().toNumber()).toBeLessThanOrEqual(0.06 + 1e-9);
      }
      const revYear = year.revenue!;
      expect(sum(quarters.map((q) => q.revenue!)).minus(revYear).abs().toNumber()).toBe(0);
    });

    it(`${tax}: с начала года равно январь-сентябрь плюс доля октября`, () => {
      const ytd = calc({ tax, period: { kind: 'ytd' } });
      const nineMonths = calc({ tax, period: { kind: 'range', from: '2026-01-01', to: '2026-09-30' } });
      const oct = calc({ tax, period: { kind: 'month', year: 2026, month: 10 } });
      for (const e of ytd.entities.filter((x) => x.applicable)) {
        const nine = sum(ent(nineMonths, e.entityId).months.map((m) => m.tax!));
        const october = ent(oct, e.entityId).months[0]!.tax!;
        const part = dec(9.5).div(31);
        // октябрь в ytd это доля месяца (9,5 суток из 31)
        const expected = nine.plus(october.times(part));
        expect(ent(ytd, e.entityId).months.reduce((a, m) => a.plus(m.tax!), ZERO).minus(expected).abs().toNumber()).toBeLessThan(1e-6);
      }
    });
  }
});

describe('каждое число объяснено шагами формулы', () => {
  const periods: Period[] = [
    { kind: 'month', year: 2026, month: 3 },
    { kind: 'quarter', year: 2026, quarter: 3 },
    { kind: 'quarter', year: 2026, quarter: 4 },
    { kind: 'year', year: 2026 },
    { kind: 'ytd' },
    { kind: 'range', from: '2026-03-16', to: '2026-05-10' },
    { kind: 'year', year: 2025 },
  ];

  for (const tax of ['vat', 'usn', 'profit'] as TaxKind[]) {
    for (const period of periods) {
      it(`${tax}, ${JSON.stringify(period)}`, () => {
        const r = calc({ tax, period });
        expect(verifyCalcResult(r)).toEqual([]);
        // шаги идут по порядку и не ссылаются вперёд
        expect(r.steps.map((s) => s.id)).toEqual(r.steps.map((_, i) => `s${i + 1}`));
      });
    }
  }

  it('при заданных ставках и для одного юрлица', () => {
    for (const rate of [5, 7, 22] as const) {
      for (const id of ['alfa', 'beta', 'delta', 'gamma', 'epsilon']) {
        for (const tax of ['vat', 'usn', 'profit'] as TaxKind[]) {
          const r = calc({ entityIds: [id], tax, rate, period: { kind: 'year', year: 2026 } });
          expect(verifyCalcResult(r), `${id} ${tax} ${rate}`).toEqual([]);
        }
      }
    }
  });

  it('независимый пересчёт НДС по строкам помесячной выручки из базы', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 1 } });
    const rows = data.revenue
      .filter((x) => x.entityId === 'alfa' && x.year === 2026 && x.month <= 3)
      .sort((a, b) => a.month - b.month);
    expect(rows).toHaveLength(3);
    const alfa = ent(r, 'alfa');
    rows.forEach((row, i) => {
      const m = alfa.months[i]!;
      expect(m.revenue!.eq(row.amount)).toBe(true);
      expect(m.tax!.minus(row.amount.times(5).div(105)).abs().toNumber()).toBeLessThan(1e-9);
      expect(m.basis).toBe('fact');
      expect(m.sourceId).toBe('demo-1c');
    });
    const total = round2(sum(rows.map((x) => x.amount.times(5).div(105))));
    expect(alfa.tax!.eq(total)).toBe(true);
  });

  it('строка формулы с подставленными числами', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'month', year: 2026, month: 3 } });
    const step = r.steps.find((s) => s.text.startsWith('НДС 5%'))!;
    expect(plain(step.text)).toBe('НДС 5%: выручка 1 988 000 ₽ × 5 / 105 = 94 666,67 ₽');
    expect(step.expression).toBe('s1 * 5 / 105');
    expect(plain(r.steps[0]!.text)).toBe('выручка по факту 1 988 000 ₽');

    const general = calc({ entityIds: ['epsilon'], tax: 'vat', period: { kind: 'month', year: 2026, month: 3 } });
    const s22 = general.steps.find((s) => s.text.startsWith('НДС 22%'))!;
    // 74 000 000 × 0,07 = 5 180 000; × 22 / 122 × (1 - 0,55)
    expect(plain(s22.text)).toMatch(/^НДС 22%: выручка 5 180 000 ₽ × 22 \/ 122 × \(1 - 0,55\) = 420 \d{3},\d{2} ₽/);
  });

  it('шаг прогноза и доли месяца описывает, откуда число', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'ytd' } });
    const oct = r.steps.find((s) => s.month === '2026-10' && s.text.startsWith('прогноз'))!;
    const expected = moneyText(dec(28_400_000).times('0.06').times('9.5').div(31));
    expect(plain(oct.text)).toBe(`прогноз выручки года 28 400 000 ₽ × доля месяца 0,06 × 9,5 / 31 = ${plain(expected)}`);
  });

  it('подмена результата шага обнаруживается', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'month', year: 2026, month: 3 } });
    expect(verifyCalcResult(r)).toEqual([]);
    const forged: CalcResult = {
      ...r,
      steps: r.steps.map((s) => (s.id === 's2' ? { ...s, result: s.result.plus(1) } : s)),
    };
    expect(verifyCalcResult(forged).length).toBeGreaterThan(0);
    const wrongTotal: CalcResult = { ...r, total: r.total!.plus(0.01) };
    expect(verifyCalcResult(wrongTotal).join(' ')).toMatch(/итог по группе/);
  });

  it('деньги только Decimal: в результате нет числа number там, где сумма', () => {
    const allowed = new Set(['year', 'month', 'rate', 'daysInMonth']);
    const r = calc({ tax: 'vat', period: { kind: 'ytd' } });
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number') {
        const key = path.split('.').pop()!.replace(/\[\d+\]/g, '');
        if (!allowed.has(key)) bad.push(`${path}=${v}`);
      } else if (D.isDecimal(v)) {
        // Decimal: деньги
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(r, 'result');
    expect(bad).toEqual([]);
    // и результат уходит по сети без потерь
    const json = JSON.parse(JSON.stringify(r)) as { total: string; entities: { tax: string }[] };
    expect(typeof json.total).toBe('string');
    expect(dec(json.total).eq(r.total!)).toBe(true);
  });
});

describe('источник, момент и правила', () => {
  it('источник, as_of, границы периода и подпись', () => {
    const r = calc({ tax: 'vat', period: { kind: 'month', year: 2026, month: 2 } });
    expect(r.source).toMatchObject({ id: 'demo-1c', title: 'Выгрузка из 1С (демо)', isDemo: true, kind: 'demo_1c' });
    expect(r.source!.loadedAt).toBe('2026-10-10T06:00:00.000Z');
    expect(r.asOf).toBe('2026-10-10');
    expect(r.periodLabel).toBe('февраль 2026');
    expect([r.from, r.to]).toEqual(['2026-02-01', '2026-02-28']);
    expect(r.taxName).toBe('НДС');
  });

  it('правила: ключ, норма, действует с', () => {
    const r = calc({ entityIds: ['alfa', 'delta'], tax: 'vat', period: { kind: 'year', year: 2026 } });
    const keys = r.rules.map((x) => x.key);
    expect(keys).toContain('rate_special_5');
    expect(keys).toContain('vat_exempt_limit');
    expect(keys).not.toContain('rate_general');
    const five = r.rules.find((x) => x.key === 'rate_special_5')!;
    expect(five).toMatchObject({ norm: 'НК РФ, ст. 164', validFrom: '2026-01-01', validTo: '2026-12-31' });
    const limit = r.rules.find((x) => x.key === 'vat_exempt_limit')!;
    expect(limit.norm).toBe('НК РФ, ст. 145');
    expect(dec(limit.value!).eq(20_000_000)).toBe(true);
  });

  it('УСН: ставка юрлица главнее справочника и в правилах не значится; без неё правило применено', () => {
    const r = calc({ entityIds: ['beta'], tax: 'usn', period: { kind: 'year', year: 2026 } });
    expect(r.rules.map((x) => x.key)).toEqual(expect.arrayContaining(['usn_min_tax_rate', 'rate_special_5']));
    expect(r.rules.map((x) => x.key)).not.toContain('usn_rate_income_expense');

    const noRate = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => (e.id === 'beta' ? { ...e, usnRate: null } : e)),
      weights: data.weights,
      ruleRows: data.ruleRows,
      choices: data.choices,
      revenue: data.revenue,
      source: data.source,
    });
    const r2 = calc({ entityIds: ['beta'], tax: 'usn', period: { kind: 'year', year: 2026 } }, noRate);
    expect(r2.rules.find((x) => x.key === 'usn_rate_income_expense')).toMatchObject({ norm: 'НК РФ, ст. 346.20, п. 2' });
    // справочная ставка 15% даёт то же число
    expect(ent(r2, 'beta').tax!.eq(ent(r, 'beta').tax!)).toBe(true);
  });

  it('налог на прибыль: правило ставки и общая ставка НДС', () => {
    const r = calc({ entityIds: ['epsilon'], tax: 'profit', period: { kind: 'year', year: 2026 } });
    expect(r.rules.map((x) => x.key)).toEqual(['profit_tax_rate', 'rate_general']);
  });

  it('выбранная ставка из базы действует, заданная в вызове главнее', async () => {
    await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
    const [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
    await saveRateChoice(db, { entityId: 'alfa', year: 2026, rate: 22, userId });
    await saveRateChoice(db, { entityId: 'alfa', year: 2025, rate: 7, userId });
    const fresh = await loadCalcData(db, T);

    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'year', year: 2026 } }, fresh);
    expect(ent(r, 'alfa').rate).toBe(22);
    near(ent(r, 'alfa').tax, 921_836);
    const forced = calc({ entityIds: ['alfa'], tax: 'vat', rate: 7, period: { kind: 'year', year: 2026 } }, fresh);
    expect(ent(forced, 'alfa').rate).toBe(7);
    near(ent(forced, 'alfa').tax, 1_857_944);
    expect(fresh.choices[2025]).toEqual({ alfa: 7 });
  });
});

describe('признак факт, прогноз, смесь', () => {
  const kindOf = (period: Period) => calc({ tax: 'vat', period }).kind;

  it('по периодам на дату теста', () => {
    expect(kindOf({ kind: 'month', year: 2026, month: 3 })).toBe('fact');
    expect(kindOf({ kind: 'quarter', year: 2026, quarter: 3 })).toBe('fact');
    expect(kindOf({ kind: 'year', year: 2025 })).toBe('fact');
    expect(kindOf({ kind: 'month', year: 2026, month: 10 })).toBe('mixed');
    expect(kindOf({ kind: 'quarter', year: 2026, quarter: 4 })).toBe('mixed');
    expect(kindOf({ kind: 'ytd' })).toBe('mixed');
    expect(kindOf({ kind: 'year', year: 2026 })).toBe('mixed');
    expect(kindOf({ kind: 'month', year: 2026, month: 11 })).toBe('forecast');
    expect(kindOf({ kind: 'range', from: '2026-11-01', to: '2026-12-31' })).toBe('forecast');
  });

  it('месяцы: факт по сентябрь, октябрь идёт, ноябрь и декабрь прогноз', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'year', year: 2026 } });
    const statuses = ent(r, 'alfa').months.map((m) => m.status);
    expect(statuses).toEqual([
      ...Array(9).fill('fact'),
      'partial',
      'forecast',
      'forecast',
    ]);
    expect(ent(r, 'alfa').months.slice(0, 9).every((m) => m.basis === 'fact')).toBe(true);
    expect(ent(r, 'alfa').months.slice(9).every((m) => m.basis === 'forecast')).toBe(true);
  });

  it('прогноз и факт январь-сентябрь не расходятся с дашбордом: тот же месячный ряд', () => {
    const r = calc({ tax: 'vat', period: { kind: 'year', year: 2026 } });
    const input = dashboardInput(data);
    for (const e of input.entities) {
      const months = ent(r, e.id).months;
      const annual = sum(months.map((m) => m.revenue!));
      expect(annual.minus(e.annualRevenue).abs().toNumber()).toBeLessThan(1e-9);
    }
  });

  it('прошедший месяц без факта в источнике считается прогнозом с предупреждением', () => {
    const stale = withRevenue(data, (rows) =>
      rows.map((r) => (r.entityId === 'alfa' && r.year === 2026 && r.month === 8 ? { ...r, isFact: false } : r)),
    );
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 3 } }, stale);
    const aug = ent(r, 'alfa').months[1]!;
    expect(aug.status).toBe('forecast');
    expect(aug.basis).toBe('forecast');
    expect(r.kind).toBe('mixed');
    expect(r.warnings.map((w) => w.kind)).toContain('no_fact');
    expect(dataKind(stale, { kind: 'quarter', year: 2026, quarter: 3 })).toBe('mixed');
    expect(dataKind(data, { kind: 'quarter', year: 2026, quarter: 3 })).toBe('fact');
    expect(verifyCalcResult(r)).toEqual([]);
  });

  it('признак данных за год для дашборда', () => {
    expect(dataKind(data, { kind: 'year', year: 2026 })).toBe('mixed');
    expect(dataKind(data, { kind: 'year', year: 2025 })).toBe('fact');
    expect(dataKind(data, { kind: 'year', year: 2027 })).toBe('forecast');
  });
});

describe('период: доли месяцев', () => {
  it('диапазон захватывает месяцы частично: выручка по дням', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'range', from: '2026-03-16', to: '2026-04-15' } });
    const [mar, apr] = ent(r, 'alfa').months;
    expect(mar!.coverage.toNumber()).toBeCloseTo(16 / 31, 12);
    expect(apr!.coverage.toNumber()).toBeCloseTo(15 / 30, 12);
    expect(mar!.revenue!.minus(dec(1_988_000).times(16).div(31)).abs().toNumber()).toBeLessThan(1e-9);
    expect(apr!.revenue!.minus(dec(1_420_000).times(15).div(30)).abs().toNumber()).toBeLessThan(1e-9);
    expect(r.steps.some((s) => /× 16 \/ 31/.test(plain(s.text)))).toBe(true);
    expect(verifyCalcResult(r)).toEqual([]);
  });

  it('период целиком в прошлом даёт те же числа при любом «сегодня» после него', () => {
    const later = buildCalcData({
      today: moment(2026, 12, 20, 9, 0, 0),
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: data.ruleRows,
      choices: data.choices,
      revenue: data.revenue,
      source: data.source,
    });
    const a = calc({ tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 1 } });
    const b = calc({ tax: 'vat', period: { kind: 'quarter', year: 2026, quarter: 1 } }, later);
    expect(b.total!.eq(a.total!)).toBe(true);
  });
});

describe('предупреждения', () => {
  it('освобождено и порог: Дельта пересечёт порог в декабре, налог начнётся в январе 2027', () => {
    const r = calc({ entityIds: ['delta', 'gamma'], tax: 'vat', period: { kind: 'year', year: 2026 } });
    const kinds = r.warnings.map((w) => `${w.entityId}:${w.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(['delta:exempt', 'delta:threshold', 'gamma:exempt']));
    expect(kinds).not.toContain('gamma:threshold');
    const th = r.warnings.find((w) => w.kind === 'threshold')!;
    expect(th.text).toMatch(/ИП Дельта/);
    expect(th.text).toMatch(/19 декабря/);
    expect(th.text).toMatch(/1 января 2027/);
    expect(ent(r, 'delta').months.every((m) => m.exempt && m.tax!.isZero())).toBe(true);
    expect(r.total!.isZero()).toBe(true);
    // уровни по порядку: предупреждения перед сведениями
    const levels = r.warnings.map((w) => w.level);
    expect(levels).toEqual([...levels].sort((a, b) => ['crit', 'warn', 'info'].indexOf(a) - ['crit', 'warn', 'info'].indexOf(b)));
  });

  it('период через границу года: налог года считается по ставке НДС года «сегодня»', () => {
    const picked = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: data.ruleRows,
      choices: { 2025: { alfa: 7 }, 2026: { alfa: 22 } },
      revenue: data.revenue,
      source: data.source,
    });
    const across = calc(
      { entityIds: ['alfa'], tax: 'usn', period: { kind: 'range', from: '2025-12-01', to: '2026-01-31' } },
      picked,
    );
    const jan = calc({ entityIds: ['alfa'], tax: 'usn', period: { kind: 'month', year: 2026, month: 1 } }, picked);
    expect(ent(across, 'alfa').months[0]!.tax).toBeNull();
    expect(ent(across, 'alfa').months[1]!.tax!.eq(ent(jan, 'alfa').months[0]!.tax!)).toBe(true);
    // ставка 22%: доходы без НДС 23 278 689, налог года 1 396 721, январь 7% года
    near(ent(jan, 'alfa').months[0]!.tax!.times(1 / 0.07), 1_396_721, 1);
    expect(verifyCalcResult(across)).toEqual([]);
  });

  it('на плательщика предупреждений об освобождении нет', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'year', year: 2026 } });
    expect(r.warnings).toEqual([]);
  });

  it('нет правил на год: налог не посчитан, выручка показана, итог пуст', () => {
    for (const year of [2025, 2027]) {
      const r = calc({ tax: 'vat', period: { kind: 'year', year } });
      expect(r.total).toBeNull();
      expect(r.warnings.find((w) => w.kind === 'no_rules')!.text).toContain(`${year} год`);
      expect(ent(r, 'alfa').tax).toBeNull();
      expect(r.rules).toEqual([]);
    }
    const y25 = calc({ tax: 'vat', period: { kind: 'year', year: 2025 } });
    expect(y25.kind).toBe('fact');
    near(y25.revenue, 134_700_000, 0.001);
    expect(ent(y25, 'alfa').months.every((m) => m.basis === 'fact' && m.tax === null)).toBe(true);
    // 2027: правил нет и данных тоже нет
    const y27 = calc({ tax: 'vat', period: { kind: 'year', year: 2027 } });
    expect(y27.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(['no_rules', 'no_data']));
    expect(y27.revenue).toBeNull();
    expect(verifyCalcResult(y27)).toEqual([]);
  });

  it('период через границу года: правила только на 2026, итог не объявляется полным', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'range', from: '2025-12-01', to: '2026-01-31' } });
    expect(r.total).toBeNull();
    const [dec25, jan26] = ent(r, 'alfa').months;
    expect(dec25!.tax).toBeNull();
    expect(jan26!.tax).not.toBeNull();
    expect(r.warnings.map((w) => w.kind)).toContain('no_rules');
    expect(verifyCalcResult(r)).toEqual([]);
  });

  it('налог не для режима юрлица: юрлицо не входит в итог', () => {
    const usn = calc({ tax: 'usn', period: { kind: 'year', year: 2026 } });
    expect(ent(usn, 'epsilon')).toMatchObject({ applicable: false, tax: null, revenue: null });
    expect(usn.warnings.some((w) => w.kind === 'not_applicable' && w.entityId === 'epsilon')).toBe(true);
    const total = sum(usn.entities.filter((e) => e.applicable).map((e) => e.tax!));
    expect(usn.total!.eq(total)).toBe(true);

    const onlyEpsilon = calc({ entityIds: ['epsilon'], tax: 'usn', period: { kind: 'year', year: 2026 } });
    expect(onlyEpsilon.total).toBeNull();
    expect(onlyEpsilon.revenue!.isZero()).toBe(true);
  });

  it('на ОСНО ставка НДС одна: заданная не применяется, об этом предупреждение', () => {
    const r = calc({ entityIds: ['epsilon'], tax: 'vat', rate: 5, period: { kind: 'year', year: 2026 } });
    expect(ent(r, 'epsilon').rate).toBe(22);
    expect(r.warnings.map((w) => w.kind)).toContain('rate_fixed');
    near(ent(r, 'epsilon').tax, 6_004_918);
  });

  it('УСН за год без данных о расходах: налог не посчитан', () => {
    const rules2025 = SEED_RULE_ROWS.filter((x) => x.validFrom === '2026-01-01').map((x) => ({
      ...x,
      validFrom: '2025-01-01',
      validTo: '2025-12-31',
    }));
    const withPast = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: [...data.ruleRows, ...rules2025],
      choices: data.choices,
      revenue: data.revenue,
      source: data.source,
    });
    const r = calc({ entityIds: ['alfa'], tax: 'usn', period: { kind: 'year', year: 2025 } }, withPast);
    expect(r.total).toBeNull();
    expect(r.warnings.map((w) => w.kind)).toContain('no_data');
  });
});

describe('пересчёт задним числом: правила того года', () => {
  const rules2025 = SEED_RULE_ROWS.filter((x) => x.validFrom === '2026-01-01').map((x) => ({
    ...x,
    validFrom: '2025-01-01',
    validTo: '2025-12-31',
    norm: x.norm ? `${x.norm} (ред. 2025)` : x.norm,
  }));

  const withPast = (edit?: (rows: CalcData['revenue']) => CalcData['revenue']): CalcData =>
    buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: [...data.ruleRows, ...rules2025],
      choices: data.choices,
      revenue: edit ? edit(data.revenue.map((r) => ({ ...r }))) : data.revenue,
      source: data.source,
    });

  it('НДС за 2025 считается по фактам и правилам 2025 года', () => {
    const r = calc({ tax: 'vat', period: { kind: 'year', year: 2025 } }, withPast());
    expect(r.warnings.map((w) => w.kind)).not.toContain('no_rules');
    expect(r.kind).toBe('fact');
    const alfaExpected = round2(dec(25_100_000).times(5).div(105));
    expect(ent(r, 'alfa').tax!.eq(alfaExpected)).toBe(true);
    const epsExpected = round2(dec(66_500_000).times(22).div(122).times(dec(1).minus('0.55')));
    expect(ent(r, 'epsilon').tax!.eq(epsExpected)).toBe(true);
    // Дельта за 2025 порог не пересекла
    expect(ent(r, 'delta').tax!.isZero()).toBe(true);
    expect(r.rules.every((x) => x.validFrom === '2025-01-01')).toBe(true);
    expect(r.rules.find((x) => x.key === 'rate_special_5')!.norm).toContain('ред. 2025');
    expect(verifyCalcResult(r)).toEqual([]);
  });

  it('освобождённое юрлицо в прошлом году платит со следующего месяца после порога', () => {
    const doubled = withPast((rows) =>
      rows.map((r) => (r.entityId === 'delta' && r.year === 2025 ? { ...r, amount: r.amount.times(2) } : r)),
    );
    const r = calc({ entityIds: ['delta'], tax: 'vat', period: { kind: 'year', year: 2025 } }, doubled);
    const months = ent(r, 'delta').months;
    // 35,2 млн × (.06+.07+.08+.05+.06+.08+.12+.15) = 23,58 млн к концу августа, порог 20 млн
    expect(months.map((m) => m.exempt)).toEqual([
      true, true, true, true, true, true, true, true, false, false, false, false,
    ]);
    const base = sum(months.slice(8).map((m) => m.revenue!));
    expect(ent(r, 'delta').tax!.eq(round2(base.times(5).div(105)))).toBe(true);
    expect(r.warnings.find((w) => w.kind === 'threshold')!.text).toMatch(/в августе 2025/);
  });

  it('диапазон через границу года берёт правила каждого года', () => {
    const r = calc({ entityIds: ['alfa'], tax: 'vat', period: { kind: 'range', from: '2025-11-01', to: '2026-02-28' } }, withPast());
    expect(r.total).not.toBeNull();
    const years = new Set(r.rules.map((x) => x.validFrom));
    expect(years).toEqual(new Set(['2025-01-01', '2026-01-01']));
  });
});

describe('ошибки входа', () => {
  it('неизвестное юрлицо, пустой список, чужая ставка, чужой налог', () => {
    expect(() => calc({ entityIds: ['zeta'], tax: 'vat', period: { kind: 'ytd' } })).toThrow(CalcInputError);
    expect(() => calc({ entityIds: [], tax: 'vat', period: { kind: 'ytd' } })).toThrow(CalcInputError);
    expect(() => calc({ tax: 'vat', rate: 6 as 5, period: { kind: 'ytd' } })).toThrow(CalcInputError);
    expect(() => calc({ tax: 'excise' as TaxKind, period: { kind: 'ytd' } })).toThrow(CalcInputError);
  });

  it('вход дашборда без правил на сегодня бросает ту же ошибку, что раньше', () => {
    const empty = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: [],
      choices: {},
      revenue: data.revenue,
      source: data.source,
    });
    expect(() => dashboardInput(empty)).toThrow(MissingRuleError);
    // а расчёт без правил не падает: выручка есть, налога нет
    const r = calc({ tax: 'vat', period: { kind: 'year', year: 2026 } }, empty);
    expect(r.total).toBeNull();
    expect(r.warnings[0]!.kind).toBe('no_rules');
  });

  it('снимок проверяет веса сезонности', () => {
    expect(() =>
      buildCalcData({
        today: T,
        entities: [],
        weights: data.weights.slice(0, 11),
        ruleRows: [],
        choices: {},
        revenue: [],
        source: null,
      }),
    ).toThrow(/12 месяцев/);
  });
});

describe('сценарий прогноза следующего года', () => {
  const y2027: Period = { kind: 'year', year: 2027 };
  const forecast = (growth: number, rate?: 5 | 7 | 22, entityIds: CalcTaxArgs['entityIds'] = 'all') =>
    calc({ tax: 'vat', period: y2027, rate, entityIds, scenario: { kind: 'forecast', year: 2027, growth } });

  it('выручка как в 2026: налог по ставке совпадает с годовым расчётом 2026 года', () => {
    const plain2026 = (rate: 5 | 7 | 22) => calc({ tax: 'vat', rate, period: { kind: 'year', year: 2026 } });
    for (const rate of [5, 7, 22] as const) {
      const f = forecast(0, rate);
      expect(ent(f, 'alfa').tax!.toString()).toBe(ent(plain2026(rate), 'alfa').tax!.toString());
      expect(ent(f, 'beta').tax!.toString()).toBe(ent(plain2026(rate), 'beta').tax!.toString());
    }
    const f5 = forecast(0, 5);
    expect(ent(f5, 'alfa').tax!.toString()).toBe(round2(dec(28_400_000).times(5).div(105)).toString());
    expect(f5.kind).toBe('forecast');
    expect(f5.scenario).toEqual({ kind: 'forecast', year: 2027, growth: 0, limitsApproved: false });
    expect(f5.periodLabel).toBe('2027 год');
    expect(ent(f5, 'alfa').months.every((m) => m.status === 'forecast' && m.basis === 'forecast')).toBe(true);
  });

  it('контрольные числа CALC.md: налог по трём ставкам при росте 0', () => {
    const at = (rate: 5 | 7 | 22, id: string) => ent(forecast(0, rate), id).tax!.toFixed(2);
    expect([5, 7, 22].map((r) => at(r as 5 | 7 | 22, 'alfa'))).toEqual(['1352380.95', '1857943.93', '921836.07']);
    expect([5, 7, 22].map((r) => at(r as 5 | 7 | 22, 'beta'))).toEqual(['1047619.05', '1439252.34', '2618360.66']);
    expect(at(5, 'delta')).toBe('995238.10');
    expect(at(22, 'delta')).toBe('3090459.02');
    expect([5, 7, 22].map((r) => at(r as 5 | 7 | 22, 'gamma'))).toEqual(['0.00', '0.00', '0.00']);
    expect(at(5, 'epsilon')).toBe('6004918.03');
  });

  it('сравнение ставок: лучшая, следующая по выгоде, экономия и итог группы из сервиса', () => {
    const c = compareRates({ entityIds: 'all', period: y2027, scenario: { kind: 'forecast', year: 2027, growth: 0 } }, data);
    const row = (id: string) => c.rows.find((r) => r.entityId === id)!;
    expect([row('alfa').best, row('alfa').against]).toEqual([22, 5]);
    expect([row('beta').best, row('beta').against]).toEqual([5, 7]);
    expect([row('delta').best, row('delta').against]).toEqual([5, 7]);
    expect(row('gamma').exemptAll).toBe(true);
    expect(row('gamma').best).toBeNull();
    expect(row('alfa').saving!.toFixed(2)).toBe(
      ent(forecast(0, 5), 'alfa').tax!.minus(ent(forecast(0, 22), 'alfa').tax!).toFixed(2),
    );
    // ОСНО отдельно: ставка одна
    expect(c.osno.map((o) => o.entityId)).toEqual(['epsilon']);
    expect(c.osno[0]!.tax.toFixed(2)).toBe('6004918.03');
    // итог группы: лучшая ставка каждого юрлица плюс ОСНО
    const best = sum([
      row('alfa').tax[22],
      row('beta').tax[5],
      row('delta').tax[5],
      ZERO,
      c.osno[0]!.tax,
    ]);
    expect(c.bestTotal.toFixed(2)).toBe(best.toFixed(2));
    expect(c.savingTotal.toFixed(2)).toBe(
      sum(c.rows.map((r) => r.saving ?? ZERO)).toFixed(2),
    );
    // три прогона на трёх ставках; шаги каждого проходят проверку
    expect(c.runs.map((r) => r.rate)).toEqual([5, 7, 22]);
    for (const r of c.runs) expect(verifyCalcResult(r.result)).toEqual([]);
  });

  it('рост выручки: налог растёт на тот же коэффициент', () => {
    const base = ent(forecast(0, 5), 'alfa').tax!;
    const plus10 = ent(forecast(10, 5), 'alfa').tax!;
    near(plus10, base.times('1.1').toNumber(), 0.05);
    const plus20 = ent(forecast(20, 7), 'beta').tax!;
    near(plus20, ent(forecast(0, 7), 'beta').tax!.times('1.2').toNumber(), 0.05);
  });

  it('помесячно по сезонности, итог за год равен сумме месяцев', () => {
    const r = forecast(0, 5, ['alfa']);
    const alfa = ent(r, 'alfa');
    expect(alfa.months).toHaveLength(12);
    // июль 2027: вес сезонности .13 от годовой выручки
    const july = alfa.months.find((m) => m.key === '2027-07')!;
    expect(july.revenue!.toString()).toBe(dec(28_400_000).times('0.13').toString());
    near(sum(alfa.months.map((m) => m.tax!)), alfa.tax!.toNumber(), 0.01);
  });

  it('освобождённое юрлицо, прошедшее порог в 2026 году, в 2027 году платит весь год (Дельта)', () => {
    const r = forecast(0, 5);
    const delta = ent(r, 'delta');
    expect(delta.months.some((m) => m.exempt)).toBe(false);
    near(delta.tax, ent(calc({ tax: 'vat', rate: 5, period: { kind: 'year', year: 2026 } }, data), 'delta').revenue!.times(5).div(105).toNumber(), 0.01);
    expect(delta.tax!.gt(0)).toBe(true);
    expect(r.assumptions.some((a) => a.includes('ИП Дельта') && a.includes('1 января 2027'))).toBe(true);
    expect(r.warnings.some((w) => w.entityId === 'delta' && /1 января 2027/.test(w.text))).toBe(true);
  });

  it('освобождённое юрлицо ниже порога остаётся освобождённым (Гамма)', () => {
    const r = forecast(0, 5);
    const gamma = ent(r, 'gamma');
    expect(gamma.tax!.isZero()).toBe(true);
    expect(gamma.months.every((m) => m.exempt)).toBe(true);
  });

  it('допущения: выручка, лимиты как в 2026, значения из справочника', () => {
    const r = forecast(0, 5);
    expect(r.assumptions[0]).toContain('как в 2026');
    const limits = r.assumptions.find((a) => a.startsWith('Лимиты 2027'))!;
    expect(plain(limits)).toContain('272,5 млн');
    expect(plain(limits)).toContain('490,5 млн');
    expect(limits).toContain('дефлятор не утверждён');
    expect(forecast(10, 5).assumptions[0]).toContain('с ростом 10%');
    // правила следующего года в расчёте: значения 2026, действуют с 1 января 2027
    const limit5 = r.rules.find((x) => x.key === 'limit_5')!;
    expect(limit5.validFrom).toBe('2027-01-01');
    expect(Number(limit5.value)).toBe(272_500_000);
    expect(limit5.note).toContain('дефлятор');
  });

  it('шаги формул проходят проверку, расчёт по данным без допущений', () => {
    for (const rate of [5, 7, 22] as const) expect(verifyCalcResult(forecast(15, rate))).toEqual([]);
    const plainResult = calc({ tax: 'vat', period: { kind: 'year', year: 2026 } });
    expect(plainResult.assumptions).toEqual([]);
    expect(plainResult.scenario).toBeNull();
  });

  it('неподдерживаемое: не следующий год, не НДС, период не в сценарном году, рост вне границ', () => {
    const bad = (args: Partial<CalcTaxArgs> & { scenario: NonNullable<CalcTaxArgs['scenario']> }) =>
      expect(() => calc({ tax: 'vat', period: y2027, ...args })).toThrow(CalcInputError);
    bad({ scenario: { kind: 'forecast', year: 2028, growth: 0 }, period: { kind: 'year', year: 2028 } });
    bad({ tax: 'usn', scenario: { kind: 'forecast', year: 2027, growth: 0 } });
    bad({ period: { kind: 'year', year: 2026 }, scenario: { kind: 'forecast', year: 2027, growth: 0 } });
    bad({ scenario: { kind: 'forecast', year: 2027, growth: 1000 } });
  });

  it('без правил на текущий год сценарий не строится', () => {
    const empty = buildCalcData({
      today: data.today,
      entities: data.entities.map(({ monthly: _m, ...e }) => e),
      weights: data.weights,
      ruleRows: [],
      choices: {},
      revenue: data.revenue,
      source: data.source,
    });
    expect(() =>
      calc({ tax: 'vat', period: y2027, scenario: { kind: 'forecast', year: 2027, growth: 0 } }, empty),
    ).toThrow(CalcInputError);
  });

  it('ОСНО: ставка одна, 22% с вычетом, при любой заданной ставке', () => {
    const e5 = ent(forecast(0, 5), 'epsilon');
    const e22 = ent(forecast(0, 22), 'epsilon');
    expect(e5.rate).toBe(22);
    expect(e5.tax!.toString()).toBe(e22.tax!.toString());
  });
});
