import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baseRev,
  bestRate,
  breakEvenShare,
  crossing,
  forecast,
  frac,
  groupSaving,
  groupTotal,
  groupTotals,
  monthAmount,
  snapshotEntity,
  taxFor,
  ytd,
} from './calc';
import { dec, round2, sum } from './decimal';
import { SEED_ENTITIES, SEED_RULE_ROWS, SEED_WEIGHTS, seedCtx } from './demo-data';
import { buildRuleSet, resolveRule, MissingRuleError } from './rules';
import { moment, momentFromEpoch, toIsoDate } from './time';
import type { EntityInput } from './types';

/** Фиксированный момент теста: 2026-10-10 12:00:00 */
const T = moment(2026, 10, 10, 12, 0, 0);
const ctx = seedCtx(T);
const ent = (id: string) => SEED_ENTITIES.find((e) => e.id === id)!;
const near = (actual: { toNumber(): number }, expected: number, tol = 1) =>
  expect(Math.abs(actual.toNumber() - expected)).toBeLessThanOrEqual(tol);

describe('1. формулы по трём ставкам (CALC.md, таблица)', () => {
  const table: Record<string, [number, number, number, number]> = {
    alfa: [1_352_381, 1_857_944, 921_836, 22],
    beta: [1_047_619, 1_439_252, 2_618_361, 5],
    delta: [995_238, 1_367_290, 3_090_459, 5],
    gamma: [304_762, 418_692, 230_820, 22],
  };
  for (const [id, [t5, t7, t22]] of Object.entries(table)) {
    it(`${id}: 5% / 7% / 22%`, () => {
      const e = ent(id);
      near(taxFor(5, e.annualRevenue, e.inputVatShare), t5);
      near(taxFor(7, e.annualRevenue, e.inputVatShare), t7);
      near(taxFor(22, e.annualRevenue, e.inputVatShare), t22);
    });
  }

  it('при 5% и 7% закупки на налог не влияют, при 22% отрицательный результат это возмещение', () => {
    const r = dec(10_000_000);
    expect(taxFor(5, r, dec(0)).eq(taxFor(5, r, dec('0.9')))).toBe(true);
    expect(taxFor(22, r, dec('1.2')).isNegative()).toBe(true);
  });

  it('лучшая ставка на дату теста', () => {
    expect(bestRate(ent('alfa'), ctx, T)).toBe(22);
    expect(bestRate(ent('beta'), ctx, T)).toBe(5);
    // у освобождённых базы до конца года нет, при равенстве (все нули) побеждает меньшая
    expect(bestRate(ent('delta'), ctx, T)).toBe(5);
    expect(bestRate(ent('gamma'), ctx, T)).toBe(5);
  });
});

describe('2. граница выгодности 22% к 5%', () => {
  it('p около 73,6%', () => {
    const p = breakEvenShare(5, 22);
    expect(p.toNumber()).toBeCloseTo(0.736, 3);
  });
  it('выше границы 22% дешевле, ниже 5% дешевле', () => {
    const r = dec(10_000_000);
    expect(taxFor(22, r, dec('0.75')).lt(taxFor(5, r, dec('0.75')))).toBe(true);
    expect(taxFor(22, r, dec('0.72')).gt(taxFor(5, r, dec('0.72')))).toBe(true);
  });
});

describe('3. frac', () => {
  it('на дату теста 0,79838709677...', () => {
    expect(frac(SEED_WEIGHTS, T).toNumber()).toBeCloseTo(0.7983870967741936, 12);
  });
  it('накопленная выручка с начала года на дату теста', () => {
    near(ytd(ent('alfa'), ctx, T), 22_674_194);
    near(ytd(ent('beta'), ctx, T), 17_564_516);
    near(ytd(ent('delta'), ctx, T), 16_686_290);
    near(ytd(ent('gamma'), ctx, T), 5_109_677);
  });
  it('начало года дает 0', () => {
    expect(frac(SEED_WEIGHTS, moment(2026, 1, 1, 0, 0, 0)).isZero()).toBe(true);
  });
  it('границы месяцев: 1 число 00:00 равно сумме весов прошедших месяцев', () => {
    expect(frac(SEED_WEIGHTS, moment(2026, 7, 1)).toNumber()).toBeCloseTo(0.41, 12);
    expect(frac(SEED_WEIGHTS, moment(2026, 12, 1)).toNumber()).toBeCloseTo(0.89, 12);
  });
  it('конец года: 31 декабря 24:00 даёт ровно 1', () => {
    const end = { year: 2026, month: 11, day: 31, secondsOfDay: 86400 };
    expect(frac(SEED_WEIGHTS, end).eq(1)).toBe(true);
  });
  it('последняя секунда года практически равна 1', () => {
    const last = moment(2026, 12, 31, 23, 59, 59);
    expect(1 - frac(SEED_WEIGHTS, last).toNumber()).toBeLessThan(1e-7);
  });
  it('високосный год: 29 февраля учитывается 29 днями месяца', () => {
    const a = frac(SEED_WEIGHTS, moment(2028, 2, 15, 0, 0, 0)).toNumber();
    // 14 полных дней из 29
    expect(a).toBeCloseTo(0.07 + (0.07 * 14) / 29, 12);
    const b = frac(SEED_WEIGHTS, moment(2027, 2, 15, 0, 0, 0)).toNumber();
    expect(b).toBeCloseTo(0.07 + (0.07 * 14) / 28, 12);
  });
  it('рост равномерный внутри месяца и монотонный', () => {
    let prev = frac(SEED_WEIGHTS, moment(2026, 10, 1, 0, 0, 0));
    for (let d = 2; d <= 31; d++) {
      const cur = frac(SEED_WEIGHTS, moment(2026, 10, d, 0, 0, 0));
      expect(cur.gt(prev)).toBe(true);
      prev = cur;
    }
  });
});

describe('4. crossing', () => {
  it('Дельта пересекает порог 20 млн в декабре (19 декабря по алгоритму, см. OPEN_QUESTIONS)', () => {
    const c = crossing(ent('delta'), ctx, T)!;
    expect(c.month).toBe(11);
    expect(toIsoDate(c)).toBe('2026-12-19');
  });
  it('Гамма никогда не пересекает', () => {
    expect(crossing(ent('gamma'), ctx, T)).toBeNull();
  });
  it('плательщик не имеет даты пересечения', () => {
    expect(crossing(ent('alfa'), ctx, T)).toBeNull();
  });
  it('уже пересёк: возвращается дата самого пересечения, а не сегодняшняя', () => {
    // 60 млн в год: 20 млн накопились 5 июня; налог начался бы с 1 июля
    const rich: EntityInput = { ...ent('delta'), id: 'rich', annualRevenue: dec(60_000_000) };
    const c = crossing(rich, ctx, T)!;
    expect(toIsoDate(c)).toBe('2026-06-05');
    // и на следующий день, и через месяц дата та же: она не едет за сегодняшним числом
    for (const later of [moment(2026, 10, 11, 12), moment(2026, 11, 20, 12), moment(2026, 12, 31, 12)]) {
      expect(toIsoDate(crossing(rich, seedCtx(later), later)!)).toBe('2026-06-05');
    }
  });
  it('Дельта: дата пересечения 19 декабря не сдвигается после самой даты (20 и 31 декабря)', () => {
    for (const day of [18, 19, 20, 25, 31]) {
      const m = moment(2026, 12, day, 12);
      expect(toIsoDate(crossing(ent('delta'), seedCtx(m), m)!), `${day} декабря`).toBe('2026-12-19');
    }
  });
  it('пересечение 31 октября: НДС начинается с 1 ноября, а не с 1 декабря, и 1 ноября дата та же', () => {
    // 31 октября накопленная выручка достигает 20 млн: пересечение на границе месяцев
    const e = ent('delta');
    const base: EntityInput = { ...e, id: 'edge', annualRevenue: dec(1) };
    const monthSum = (to: number) => Array.from({ length: to }, (_, i) => SEED_WEIGHTS[i]!).reduce((a, w) => a.plus(w), dec(0));
    // годовая выручка, при которой накопление за январь–октябрь ровно равно порогу плюс рубль
    const annual = dec(20_000_001).div(monthSum(10));
    const edge: EntityInput = { ...base, annualRevenue: annual };
    const onOct = moment(2026, 10, 15, 12);
    const c = crossing(edge, seedCtx(onOct), onOct)!;
    expect(toIsoDate(c)).toBe('2026-10-31');
    const onNov = moment(2026, 11, 1, 12);
    expect(toIsoDate(crossing(edge, seedCtx(onNov), onNov)!)).toBe('2026-10-31');
  });
  it('пересечение раньше: налогооблагаемая выручка это месяцы после месяца пересечения', () => {
    const big: EntityInput = { ...ent('delta'), id: 'big', annualRevenue: dec(40_000_000) };
    const early = moment(2026, 1, 5);
    const c = crossing(big, ctx, early)!;
    // 40 млн × 0,07 × 3 = 8,4 млн к концу марта, 40 × 0,42 = 16,8 к концу июня, 40 × 0,55 = 22 к июлю
    expect(c.month).toBe(6);
    const base = baseRev(big, ctx, early);
    // месяцы после июля: авг..дек = .14+.10+.06+.05+.11 = .46
    near(base, 40_000_000 * 0.46);
  });
  it('налогооблагаемая выручка Дельты до конца 2026 равна нулю (пересечение в декабре)', () => {
    expect(baseRev(ent('delta'), ctx, T).isZero()).toBe(true);
    expect(baseRev(ent('gamma'), ctx, T).isZero()).toBe(true);
  });
  it('прогноз налога до конца 2026 при ставке 5% у всех', () => {
    near(forecast(ent('alfa'), ctx, 5, T), 1_352_381);
    near(forecast(ent('beta'), ctx, 5, T), 1_047_619);
    expect(forecast(ent('delta'), ctx, 5, T).isZero()).toBe(true);
    expect(forecast(ent('gamma'), ctx, 5, T).isZero()).toBe(true);
  });
});

describe('5. bestRate при равенстве', () => {
  it('при равных прогнозах побеждает меньшая ставка', () => {
    // при p такой, что 22% равна 5%: 1 − p = (5/105) / (22/122)
    const p = breakEvenShare(5, 22);
    const e: EntityInput = { ...ent('alfa'), inputVatShare: p };
    const best = bestRate(e, ctx, T);
    expect(best).toBe(5);
  });
  it('нулевая база: все прогнозы нули, берётся 5', () => {
    expect(bestRate(ent('gamma'), ctx, T)).toBe(5);
  });
});

describe('6. правила с датами', () => {
  const rows = [
    ...SEED_RULE_ROWS,
    { key: 'vat_exempt_limit', value: '60000000', formula: null, unit: 'rub', validFrom: '2025-01-01', validTo: '2025-12-31', norm: 'НК РФ, ст. 145', note: 'Порог 2025' },
    // правила налогов на 2025 год: пересчёт задним числом берёт записи того периода
    { key: 'profit_tax_rate', value: '20', formula: null, unit: 'percent', validFrom: '2025-01-01', validTo: '2025-12-31', norm: 'НК РФ, ст. 284', note: 'условно' },
    { key: 'usn_rate_income', value: '6', formula: null, unit: 'percent', validFrom: '2025-01-01', validTo: '2025-12-31', norm: null, note: null },
    { key: 'usn_rate_income_expense', value: '15', formula: null, unit: 'percent', validFrom: '2025-01-01', validTo: '2025-12-31', norm: null, note: null },
    { key: 'usn_min_tax_rate', value: '1', formula: null, unit: 'percent', validFrom: '2025-01-01', validTo: '2025-12-31', norm: null, note: null },
    { key: 'payment_day', value: '28', formula: null, unit: 'count', validFrom: '2025-01-01', validTo: '2025-12-31', norm: null, note: null },
  ];
  it('пересчёт за 2025 год использует правила 2025', () => {
    const r25 = buildRuleSet(rows, moment(2025, 6, 1));
    expect(r25.vatExemptLimit.toNumber()).toBe(60_000_000);
    expect(r25.year).toBe(2025);
    expect(r25.profitTaxRate.toString()).toBe('0.2');
    expect(buildRuleSet(rows, moment(2026, 6, 1)).profitTaxRate.toString()).toBe('0.25');
    const r26 = buildRuleSet(rows, moment(2026, 6, 1));
    expect(r26.vatExemptLimit.toNumber()).toBe(20_000_000);
  });
  it('resolveRule выбирает действовавшую запись', () => {
    expect(resolveRule(rows, 'vat_exempt_limit', '2025-06-01')!.value).toBe('60000000');
    expect(resolveRule(rows, 'vat_exempt_limit', '2026-06-01')!.value).toBe('20000000');
    expect(resolveRule(rows, 'vat_exempt_limit', '2027-06-01')).toBeNull();
  });
  it('нет правила на дату: понятная ошибка', () => {
    expect(() => buildRuleSet(SEED_RULE_ROWS, moment(2027, 3, 1))).toThrow(MissingRuleError);
  });
  it('лимиты 2027 это формула, дефлятор неизвестен', () => {
    expect(ctx.rules.nextYear.deflatorKnown).toBe(false);
    expect(ctx.rules.nextYear.base5!.toNumber()).toBe(250_000_000);
    expect(ctx.rules.nextYear.base7!.toNumber()).toBe(450_000_000);
    expect(ctx.rules.limit5!.toNumber()).toBe(272_500_000);
  });
  it('когда дефлятор выйдет, правка одной записи включает числа', () => {
    const patched = SEED_RULE_ROWS.map((r) =>
      r.key === 'limit_5' && r.validFrom === '2027-01-01' ? { ...r, value: '281000000' } : r,
    ).map((r) => (r.key === 'limit_7' && r.validFrom === '2027-01-01' ? { ...r, value: '505000000' } : r));
    expect(buildRuleSet(patched, T).nextYear.deflatorKnown).toBe(true);
  });
});

describe('7. деньги: группа равна сумме юрлиц без расхождения в копейку', () => {
  it('сумма выручки', () => {
    const totals = groupTotals(SEED_ENTITIES, {}, ctx, T);
    const manual = sum(SEED_ENTITIES.map((e) => round2(ytd(e, ctx, T))));
    expect(totals.ytd.eq(manual)).toBe(true);
  });
  it('на 1000 случайных моментов сумма округлённых равна сумме по группе', () => {
    for (let i = 0; i < 1000; i++) {
      const m = moment(2026, 1 + (i % 12), 1 + (i % 28), (i * 7) % 24, (i * 13) % 60, (i * 17) % 60);
      const g = groupTotal(SEED_ENTITIES.map((e) => ytd(e, ctx, m)));
      const s = sum(SEED_ENTITIES.map((e) => round2(ytd(e, ctx, m))));
      expect(g.eq(s)).toBe(true);
    }
  });
  it('экономия по группе при выбранной ставке 5% у всех: Альфа 22% дешевле', () => {
    const save = groupSaving(SEED_ENTITIES, {}, ctx, T);
    near(save, 1_352_381 - 921_836, 2);
  });
});

describe('факты месяцев', () => {
  it('факт заменяет прогноз только для прошедших месяцев', () => {
    const e: EntityInput = {
      ...ent('alfa'),
      monthly: [{ month: 0, amount: dec(3_000_000), isFact: true }, { month: 10, amount: dec(9), isFact: true }],
    };
    expect(monthAmount(e, ctx, 0, T).eq(3_000_000)).toBe(true);
    // ноябрь ещё не прошёл: берём прогноз, а не факт
    expect(monthAmount(e, ctx, 10, T).eq(dec(28_400_000).times('0.05'))).toBe(true);
    const base = ytd(ent('alfa'), ctx, T);
    near(ytd(e, ctx, T).minus(base), 3_000_000 - 28_400_000 * 0.07);
  });
});

describe('время', () => {
  it('момент в поясе Камчатки не зависит от пояса машины', () => {
    // 2026-10-09 23:30:00Z это 2026-10-10 11:30:00 по Камчатке (UTC+12)
    const m = momentFromEpoch(Date.UTC(2026, 9, 9, 23, 30, 0), 'Asia/Kamchatka');
    expect(m).toMatchObject({ year: 2026, month: 9, day: 10 });
    expect(m.secondsOfDay).toBe(11 * 3600 + 30 * 60);
  });
});

describe('сверка с эталоном docs/reference/calc_core.js', () => {
  it('расхождение не больше 1 ₽', () => {
    const script = path.resolve(__dirname, '../../docs/reference/calc_core.js');
    const out = execFileSync('node', [script], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
    const rows = out
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('frac'))
      .map((l) => {
        const t = l.split(/\s+/);
        const get = (k: string) => t[t.indexOf(k) + 1]!;
        return {
          id: t[0]!,
          ytd: Number(get('ytd')),
          t5: Number(get('t5')),
          t7: Number(get('t7')),
          t22: Number(get('t22')),
          best: Number(get('best')),
          base: Number(get('base')),
          cross: get('cross'),
          f5: Number(get('f5')),
          f22: Number(get('f22')),
        };
      });
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const e = ent(r.id);
      const s = snapshotEntity(e, {}, ctx, T);
      near(s.ytd, r.ytd);
      near(s.fullYear[5]!, r.t5);
      near(s.fullYear[7]!, r.t7);
      near(s.fullYear[22]!, r.t22);
      expect(s.best).toBe(r.best);
      near(s.baseRev, r.base);
      near(s.forecast[5]!, r.f5);
      near(s.forecast[22]!, r.f22);
      expect(s.crossing ? toIsoDate(s.crossing) : 'null').toBe(r.cross);
    }
  });
});
