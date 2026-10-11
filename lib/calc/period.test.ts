import { describe, expect, it } from 'vitest';
import { ytd } from './calc';
import { SEED_ENTITIES, seedCtx } from './demo-data';
import {
  PeriodError,
  formatPeriod,
  formatPeriodFor,
  formatPeriodIn,
  parsePeriod,
  periodKindOf,
  resolvePeriod,
  type Period,
} from './period';
import { sum } from './decimal';
import { moment } from './time';

/** Сегодня: 10 октября 2026, 12:00 */
const T = moment(2026, 10, 10, 12, 0, 0);

describe('форматирование периода по-русски', () => {
  const cases: [Period, string][] = [
    [{ kind: 'month', year: 2026, month: 2 }, 'февраль 2026'],
    [{ kind: 'month', year: 2025, month: 12 }, 'декабрь 2025'],
    [{ kind: 'quarter', year: 2026, quarter: 1 }, '1 квартал 2026'],
    [{ kind: 'quarter', year: 2026, quarter: 4 }, '4 квартал 2026'],
    [{ kind: 'year', year: 2026 }, '2026 год'],
    [{ kind: 'ytd' }, 'с начала года'],
    [{ kind: 'range', from: '2026-03-01', to: '2026-05-31' }, 'с марта по май 2026'],
    [{ kind: 'range', from: '2025-10-01', to: '2026-02-28' }, 'с октября 2025 по февраль 2026'],
    [{ kind: 'range', from: '2026-03-01', to: '2026-03-31' }, 'март 2026'],
    [{ kind: 'range', from: '2026-03-01', to: '2026-05-15' }, 'с 1 марта по 15 мая 2026'],
    [{ kind: 'range', from: '2025-12-20', to: '2026-01-10' }, 'с 20 декабря 2025 по 10 января 2026'],
  ];
  for (const [p, text] of cases) {
    it(`${JSON.stringify(p)} → «${text}»`, () => {
      expect(formatPeriod(p)).toBe(text);
    });
  }

  it('падежные формы для фраз', () => {
    expect(formatPeriodFor({ kind: 'month', year: 2026, month: 2 })).toBe('за февраль 2026');
    expect(formatPeriodFor({ kind: 'quarter', year: 2026, quarter: 1 })).toBe('за 1 квартал 2026');
    expect(formatPeriodFor({ kind: 'ytd' })).toBe('с начала года');
    expect(formatPeriodIn({ kind: 'month', year: 2026, month: 3 })).toBe('в марте 2026');
    expect(formatPeriodIn({ kind: 'quarter', year: 2026, quarter: 2 })).toBe('в 2 квартале 2026');
    expect(formatPeriodIn({ kind: 'year', year: 2026 })).toBe('в 2026 году');
  });

  it('некорректный период', () => {
    expect(() => formatPeriod({ kind: 'month', year: 2026, month: 13 })).toThrow(PeriodError);
    expect(() => formatPeriod({ kind: 'quarter', year: 2026, quarter: 5 })).toThrow(PeriodError);
    expect(() => formatPeriod({ kind: 'year', year: 1850 })).toThrow(PeriodError);
    expect(() => formatPeriod({ kind: 'range', from: '2026-02-30', to: '2026-03-01' })).toThrow(PeriodError);
  });

  it('в подписях нет длинных тире', () => {
    const all = cases.map(([p]) => formatPeriod(p)).join(' ');
    expect(all).not.toMatch(/[‒-―−]/);
  });
});

describe('разбор периода из русского текста', () => {
  const ok: [string, Period][] = [
    ['февраль 2026', { kind: 'month', year: 2026, month: 2 }],
    ['Февраль 2026 года', { kind: 'month', year: 2026, month: 2 }],
    ['за февраль', { kind: 'month', year: 2026, month: 2 }],
    ['в феврале 2025', { kind: 'month', year: 2025, month: 2 }],
    ['мая 2026', { kind: 'month', year: 2026, month: 5 }],
    ['сент. 2026', { kind: 'month', year: 2026, month: 9 }],
    ['02.2026', { kind: 'month', year: 2026, month: 2 }],
    ['2026-02', { kind: 'month', year: 2026, month: 2 }],
    ['1 квартал 2026', { kind: 'quarter', year: 2026, quarter: 1 }],
    ['первый квартал', { kind: 'quarter', year: 2026, quarter: 1 }],
    ['за 1-й квартал 2026', { kind: 'quarter', year: 2026, quarter: 1 }],
    ['в третьем квартале 2025', { kind: 'quarter', year: 2025, quarter: 3 }],
    ['II квартал 2026', { kind: 'quarter', year: 2026, quarter: 2 }],
    ['Q4 2026', { kind: 'quarter', year: 2026, quarter: 4 }],
    ['4 кв. 2026', { kind: 'quarter', year: 2026, quarter: 4 }],
    ['2026 год', { kind: 'year', year: 2026 }],
    ['за 2025 год', { kind: 'year', year: 2025 }],
    ['в 2026 году', { kind: 'year', year: 2026 }],
    ['2026', { kind: 'year', year: 2026 }],
    ['за год', { kind: 'year', year: 2026 }],
    ['с начала года', { kind: 'ytd' }],
    ['С начала текущего года', { kind: 'ytd' }],
    ['с марта по май 2026', { kind: 'range', from: '2026-03-01', to: '2026-05-31' }],
    ['с января по март', { kind: 'range', from: '2026-01-01', to: '2026-03-31' }],
    ['с ноября по февраль 2027', { kind: 'range', from: '2026-11-01', to: '2027-02-28' }],
    ['с октября 2025 по февраль 2026', { kind: 'range', from: '2025-10-01', to: '2026-02-28' }],
    ['январь-март 2026', { kind: 'range', from: '2026-01-01', to: '2026-03-31' }],
    ['с 1 марта по 15 мая 2026', { kind: 'range', from: '2026-03-01', to: '2026-05-15' }],
    ['с 01.03.2026 по 15.05.2026', { kind: 'range', from: '2026-03-01', to: '2026-05-15' }],
    ['с 1 по 15 октября', { kind: 'range', from: '2026-10-01', to: '2026-10-15' }],
    ['с 20 декабря по 10 января 2027', { kind: 'range', from: '2026-12-20', to: '2027-01-10' }],
    ['этот месяц', { kind: 'month', year: 2026, month: 10 }],
    ['прошлый месяц', { kind: 'month', year: 2026, month: 9 }],
    ['текущий квартал', { kind: 'quarter', year: 2026, quarter: 4 }],
    ['прошлый квартал', { kind: 'quarter', year: 2026, quarter: 3 }],
    ['этот год', { kind: 'year', year: 2026 }],
    ['в прошлом году', { kind: 'year', year: 2025 }],
  ];
  for (const [text, expected] of ok) {
    it(`«${text}»`, () => {
      expect(parsePeriod(text, T)).toEqual(expected);
    });
  }

  it('относительные периоды на стыке лет', () => {
    const jan = moment(2026, 1, 15);
    expect(parsePeriod('прошлый месяц', jan)).toEqual({ kind: 'month', year: 2025, month: 12 });
    expect(parsePeriod('прошлый квартал', jan)).toEqual({ kind: 'quarter', year: 2025, quarter: 4 });
  });

  it('не период: null', () => {
    for (const text of [
      '',
      '   ',
      'привет',
      'сколько налога',
      'тринадцатый месяц',
      '13.2026',
      '5 квартал 2026',
      '2026-13',
      'с 30 февраля по 1 марта 2026',
      'с мая по март 2026 года 2027',
      '1850 год',
      'месяц',
    ]) {
      expect(parsePeriod(text, T), text).toBeNull();
    }
  });

  it('разбор обратен форматированию', () => {
    const periods: Period[] = [
      { kind: 'month', year: 2026, month: 2 },
      { kind: 'quarter', year: 2025, quarter: 4 },
      { kind: 'year', year: 2026 },
      { kind: 'ytd' },
      { kind: 'range', from: '2026-03-01', to: '2026-05-31' },
      { kind: 'range', from: '2025-10-01', to: '2026-02-28' },
      { kind: 'range', from: '2026-03-01', to: '2026-05-15' },
      { kind: 'range', from: '2025-12-20', to: '2026-01-10' },
    ];
    for (const p of periods) expect(parsePeriod(formatPeriod(p), T)).toEqual(p);
  });
});

describe('resolvePeriod: границы и признак месяцев', () => {
  it('месяц: прошедший факт, идущий частично, будущий прогноз', () => {
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 9 }, T).months[0]!.status).toBe('fact');
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 10 }, T).months[0]!.status).toBe('partial');
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 11 }, T).months[0]!.status).toBe('forecast');
    expect(resolvePeriod({ kind: 'month', year: 2025, month: 12 }, T).months[0]!.status).toBe('fact');
    expect(resolvePeriod({ kind: 'month', year: 2027, month: 1 }, T).months[0]!.status).toBe('forecast');
  });

  it('границы месяца, в том числе февраль високосного года', () => {
    const r = resolvePeriod({ kind: 'month', year: 2028, month: 2 }, T);
    expect(r.from).toBe('2028-02-01');
    expect(r.to).toBe('2028-02-29');
    expect(r.months[0]!.daysInMonth).toBe(29);
    expect(r.months[0]!.coverage.eq(1)).toBe(true);
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 2 }, T).to).toBe('2026-02-28');
  });

  it('квартал: три месяца, границы и признаки', () => {
    const q3 = resolvePeriod({ kind: 'quarter', year: 2026, quarter: 3 }, T);
    expect(q3.from).toBe('2026-07-01');
    expect(q3.to).toBe('2026-09-30');
    expect(q3.months.map((m) => m.key)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(q3.kind).toBe('fact');

    const q4 = resolvePeriod({ kind: 'quarter', year: 2026, quarter: 4 }, T);
    expect(q4.months.map((m) => m.status)).toEqual(['partial', 'forecast', 'forecast']);
    expect(q4.kind).toBe('mixed');
  });

  it('год: двенадцать месяцев, 2026 смешанный, 2025 факт, 2027 прогноз', () => {
    const y = resolvePeriod({ kind: 'year', year: 2026 }, T);
    expect(y.months).toHaveLength(12);
    expect(y.months.filter((m) => m.status === 'fact')).toHaveLength(9);
    expect(y.months.filter((m) => m.status === 'partial')).toHaveLength(1);
    expect(y.months.filter((m) => m.status === 'forecast')).toHaveLength(2);
    expect(y.kind).toBe('mixed');
    expect(resolvePeriod({ kind: 'year', year: 2025 }, T).kind).toBe('fact');
    expect(resolvePeriod({ kind: 'year', year: 2027 }, T).kind).toBe('forecast');
  });

  it('с начала года: месяцы до октября целиком, октябрь по прошедшему времени', () => {
    const r = resolvePeriod({ kind: 'ytd' }, T);
    expect(r.from).toBe('2026-01-01');
    expect(r.to).toBe('2026-10-10');
    expect(r.months).toHaveLength(10);
    expect(r.months.slice(0, 9).every((m) => m.coverage.eq(1) && m.status === 'fact')).toBe(true);
    const oct = r.months[9]!;
    expect(oct.status).toBe('partial');
    // 9 полных дней и полсуток из 31
    expect(oct.coveredDays.toNumber()).toBeCloseTo(9.5, 12);
    expect(oct.coverage.toNumber()).toBeCloseTo(9.5 / 31, 12);
    expect(r.kind).toBe('mixed');
  });

  it('с начала года: первая секунда года не даёт месяцев, дальше появляется январь', () => {
    expect(resolvePeriod({ kind: 'ytd' }, moment(2026, 1, 1, 0, 0, 0)).months).toHaveLength(0);
    const r = resolvePeriod({ kind: 'ytd' }, moment(2026, 1, 1, 6, 0, 0));
    expect(r.months).toHaveLength(1);
    expect(r.months[0]!.coverage.toNumber()).toBeCloseTo(0.25 / 31, 12);
  });

  it('с начала года совпадает с накоплением калькулятора (ytd)', () => {
    const ctx = seedCtx(T);
    const r = resolvePeriod({ kind: 'ytd' }, T);
    for (const e of SEED_ENTITIES) {
      // свой расчёт по долям месяцев: годовая выручка × вес × доля
      const mine = sum(
        r.months.map((m) => e.annualRevenue.times(ctx.weights[m.month - 1]!).times(m.coverage)),
      );
      expect(mine.minus(ytd(e, ctx, T)).abs().toNumber()).toBeLessThan(1e-6);
    }
  });

  it('диапазон через границу года и неполные месяцы', () => {
    const r = resolvePeriod({ kind: 'range', from: '2025-12-20', to: '2026-02-10' }, T);
    expect(r.months.map((m) => m.key)).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(r.months[0]!.coveredDays.toNumber()).toBe(12);
    expect(r.months[0]!.coverage.toNumber()).toBeCloseTo(12 / 31, 12);
    expect(r.months[1]!.coverage.eq(1)).toBe(true);
    expect(r.months[2]!.coveredDays.toNumber()).toBe(10);
    expect(r.months[2]!.coverage.toNumber()).toBeCloseTo(10 / 28, 12);
    expect(r.from).toBe('2025-12-20');
    expect(r.to).toBe('2026-02-10');
  });

  it('диапазон внутри одного месяца', () => {
    const r = resolvePeriod({ kind: 'range', from: '2026-10-03', to: '2026-10-09' }, T);
    expect(r.months).toHaveLength(1);
    expect(r.months[0]!.coveredDays.toNumber()).toBe(7);
    expect(r.months[0]!.status).toBe('partial');
  });

  it('ошибки: начало позже конца, несуществующая дата, чужой формат', () => {
    expect(() => resolvePeriod({ kind: 'range', from: '2026-05-01', to: '2026-04-01' }, T)).toThrow(PeriodError);
    expect(() => resolvePeriod({ kind: 'range', from: '2026-02-29', to: '2026-03-01' }, T)).toThrow(PeriodError);
    expect(() => resolvePeriod({ kind: 'range', from: '01.03.2026', to: '2026-03-31' }, T)).toThrow(PeriodError);
    expect(() => resolvePeriod({ kind: 'month', year: 2026, month: 0 }, T)).toThrow(PeriodError);
  });

  it('признак периода по статусам месяцев', () => {
    expect(periodKindOf(['fact', 'fact'])).toBe('fact');
    expect(periodKindOf(['forecast'])).toBe('forecast');
    expect(periodKindOf(['fact', 'partial'])).toBe('mixed');
    expect(periodKindOf(['partial'])).toBe('mixed');
    expect(periodKindOf(['fact', 'forecast'])).toBe('mixed');
  });
});
