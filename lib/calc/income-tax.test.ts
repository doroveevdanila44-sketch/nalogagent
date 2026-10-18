import { describe, expect, it } from 'vitest';
import { baseRev, bestRate, forecast, groupSaving, selectedRate, taxFor, ytd } from './calc';
import { dec, round2, sum } from './decimal';
import { SEED_ENTITIES, SEED_RULE_ROWS, seedCtx } from './demo-data';
import {
  cumulativeShare,
  incomeExVat,
  incomeTax,
  incomeTaxRate,
  incomeTaxSchedule,
  nextPayment,
} from './income-tax';
import { daysUntil, groupPayments, quarterRevenue } from './payments';
import { buildRuleSet } from './rules';
import { moment, toIsoDate } from './time';
import type { EntityInput } from './types';
import { buildWarnings, warningCounter } from './warnings';

/** Дата теста та же, что в CALC.md: 2026-10-10 12:00:00 */
const T = moment(2026, 10, 10, 12, 0, 0);
const ctx = seedCtx(T);
const ent = (id: string) => SEED_ENTITIES.find((e) => e.id === id)!;
const eq2 = (actual: { toFixed(n: number): string }, expected: string) => expect(actual.toFixed(2)).toBe(expected);

describe('налог на прибыль (ОСНО), ООО «Эпсилон»', () => {
  const e = ent('epsilon');

  it('прибыль = выручка × 100 / 122 минус расходы, налог 25%', () => {
    const t = incomeTax(e, ctx, {}, T);
    eq2(t.income, '60655737.70'); // 74 000 000 × 100 / 122
    eq2(t.expenses, '44000000.00');
    eq2(t.base, '16655737.70');
    expect(t.ratePct.toString()).toBe('25');
    eq2(t.forecast, '4163934.43');
    expect(t.regime).toBe('osno');
  });

  it('начислено на сегодня по сезонности', () => {
    const t = incomeTax(e, ctx, {}, T);
    // 4 163 934,43 × 0,79838709677...
    expect(Math.abs(t.accrued.toNumber() - 3_324_431.52)).toBeLessThan(1);
  });

  it('убыток налога не даёт', () => {
    const loss: EntityInput = { ...e, annualExpenses: dec(70_000_000) };
    const t = incomeTax(loss, ctx, {}, T);
    expect(t.base.isZero()).toBe(true);
    expect(t.forecast.isZero()).toBe(true);
    expect(t.accrued.isZero()).toBe(true);
  });

  it('ставка 25% берётся из справочника, правка записи меняет налог', () => {
    const rows = SEED_RULE_ROWS.map((r) => (r.key === 'profit_tax_rate' ? { ...r, value: '20' } : r));
    const c20 = { ...ctx, rules: buildRuleSet(rows, T) };
    eq2(incomeTax(e, c20, {}, T).forecast, '3331147.54'); // 20% от 16 655 737,70
  });

  it('НДС на ОСНО одна ставка 22% с вычетами, выбора нет', () => {
    expect(selectedRate(e, {})).toBe(22);
    expect(selectedRate(e, { epsilon: 5 })).toBe(22); // чужой выбор игнорируется
    expect(bestRate(e, ctx, T)).toBe(22);
    // 74 000 000 × 22/122 × (1 − 0,55)
    eq2(forecast(e, ctx, 22, T), '6004918.03');
    eq2(taxFor(22, ytd(e, ctx, T), e.inputVatShare), '4794249.07');
  });

  it('экономия по группе не растёт от юрлица на ОСНО', () => {
    const without = groupSaving(SEED_ENTITIES.filter((x) => x.id !== 'epsilon'), {}, ctx, T);
    const withEps = groupSaving(SEED_ENTITIES, {}, ctx, T);
    expect(withEps.eq(without)).toBe(true);
  });
});

describe('налог по УСН', () => {
  it('«доходы» 6%: плательщик НДС, выручка без НДС по выбранной ставке', () => {
    const alfa = ent('alfa');
    // ставка НДС 5% (по умолчанию): 28,4 млн × 100/105 × 6%
    eq2(incomeTax(alfa, ctx, {}, T).income, '27047619.05');
    eq2(incomeTax(alfa, ctx, {}, T).forecast, '1622857.14');
    // ставка НДС 22%: 28,4 млн × 100/122 × 6%
    eq2(incomeTax(alfa, ctx, { alfa: 22 }, T).income, '23278688.52');
    eq2(incomeTax(alfa, ctx, { alfa: 22 }, T).forecast, '1396721.31');
  });

  it('«доходы» 6%: освобождённый от НДС, выручка как есть', () => {
    const t = incomeTax(ent('delta'), ctx, {}, T);
    eq2(t.income, '20900000.00');
    eq2(t.forecast, '1254000.00'); // 20,9 млн × 6%
  });

  it('«доходы минус расходы» 15%, ИП Бета: контрольные числа', () => {
    const beta = ent('beta');
    const t = incomeTax(beta, ctx, {}, T); // ставка НДС 5%
    eq2(t.income, '20952380.95'); // 22 млн × 100/105
    eq2(t.base, '5552380.95'); // минус расходы 15,4 млн
    eq2(t.calculated, '832857.14');
    eq2(t.minimum, '209523.81'); // 1% доходов
    eq2(t.forecast, '832857.14');
    expect(t.minTaxApplied).toBe(false);
    expect(Math.abs(t.accrued.toNumber() - 664_942.4)).toBeLessThan(1);

    const t22 = incomeTax(beta, ctx, { beta: 22 }, T);
    eq2(t22.base, '2632786.89');
    eq2(t22.forecast, '394918.03');
  });

  it('ООО «Гамма»: освобождена от НДС, доходы минус расходы', () => {
    const t = incomeTax(ent('gamma'), ctx, {}, T);
    eq2(t.income, '6400000.00');
    eq2(t.base, '1200000.00'); // минус расходы 5,2 млн
    eq2(t.forecast, '180000.00');
    eq2(t.minimum, '64000.00');
  });

  it('минимальный налог 1% доходов, если он больше расчётного', () => {
    const beta = ent('beta');
    // расходы почти равны доходам: расчётный налог мал, действует минимальный
    const thin: EntityInput = { ...beta, annualExpenses: dec(20_800_000) };
    const t = incomeTax(thin, ctx, {}, T);
    eq2(t.base, '152380.95');
    eq2(t.calculated, '22857.14');
    eq2(t.forecast, '209523.81');
    expect(t.minTaxApplied).toBe(true);
    // расходы больше доходов: база ноль, платится минимальный
    const loss: EntityInput = { ...beta, annualExpenses: dec(30_000_000) };
    const t2 = incomeTax(loss, ctx, {}, T);
    expect(t2.base.isZero()).toBe(true);
    eq2(t2.forecast, '209523.81');
    expect(t2.minTaxApplied).toBe(true);
  });

  it('ставка юрлица главнее, без неё берётся из справочника по режиму', () => {
    const alfa = ent('alfa');
    expect(incomeTaxRate(alfa, ctx).toString()).toBe('0.06');
    expect(incomeTaxRate({ ...alfa, usnRate: null }, ctx).toString()).toBe('0.06');
    expect(incomeTaxRate({ ...alfa, usnRate: dec('0.04') }, ctx).toString()).toBe('0.04');
    expect(incomeTaxRate({ ...ent('beta'), usnRate: null }, ctx).toString()).toBe('0.15');
  });

  it('выручка без НДС при пересечении порога: облагаемая часть освобождается от своего НДС', () => {
    // ИП, пересекающий порог в июле: часть выручки облагается НДС и в доходы УСН идёт без него
    const big: EntityInput = { ...ent('delta'), id: 'big', annualRevenue: dec(40_000_000) };
    const early = moment(2026, 1, 5);
    const cx = seedCtx(early);
    const taxed = baseRev(big, cx, early); // выручка после месяца пересечения, с НДС
    expect(taxed.gt(0)).toBe(true);
    const income = incomeExVat(big, cx, { big: 22 }, early);
    eq2(income, big.annualRevenue.minus(taxed.times(22).div(122)).toFixed(2));
  });
});

describe('графики платежей и сроки', () => {
  it('авансы по УСН 28 апреля, 28 июля, 28 октября и итог за год', () => {
    const s = incomeTaxSchedule(ent('alfa'), ctx, {}, T);
    expect(s.map((p) => toIsoDate(p.due))).toEqual(['2026-04-28', '2026-07-28', '2026-10-28', '2027-03-28']);
    expect(s.map((p) => p.period)).toEqual(['q1', 'h1', '9m', 'year']);
    expect(s.map((p) => p.kind)).toEqual(['advance', 'advance', 'advance', 'final']);
  });

  it('итог за год: ООО до 28 марта, ИП до 28 апреля следующего года', () => {
    const ooo = incomeTaxSchedule(ent('gamma'), ctx, {}, T).at(-1)!;
    const ip = incomeTaxSchedule(ent('beta'), ctx, {}, T).at(-1)!;
    expect(toIsoDate(ooo.due)).toBe('2027-03-28');
    expect(toIsoDate(ip.due)).toBe('2027-04-28');
  });

  it('налог на прибыль: авансы за 3, 6, 9 месяцев и итог за год до 28 марта', () => {
    const s = incomeTaxSchedule(ent('epsilon'), ctx, {}, T);
    expect(s.map((p) => toIsoDate(p.due))).toEqual(['2026-04-28', '2026-07-28', '2026-10-28', '2027-03-28']);
    // доли накопления 0,21, 0,20 (0,41 − 0,21), 0,37 (0,78 − 0,41), остаток 0,22
    expect(s.map((p) => p.amount.toFixed(2))).toEqual(['874426.23', '832786.89', '1540655.74', '916065.57']);
  });

  it('сумма платежей равна налогу за год', () => {
    for (const e of SEED_ENTITIES) {
      const s = incomeTaxSchedule(e, ctx, {}, T);
      const total = sum(s.map((p) => p.amount));
      const tax = incomeTax(e, ctx, {}, T).forecast;
      expect(total.minus(tax).abs().lt('0.0000001'), e.id).toBe(true);
    }
  });

  it('накопленные доли по месяцам: квартал 0,21, полугодие 0,41, 9 месяцев 0,78', () => {
    const e = ent('alfa');
    expect(cumulativeShare(e, ctx, 2, T).toNumber()).toBeCloseTo(0.21, 10);
    expect(cumulativeShare(e, ctx, 5, T).toNumber()).toBeCloseTo(0.41, 10);
    expect(cumulativeShare(e, ctx, 8, T).toNumber()).toBeCloseTo(0.78, 10);
    expect(cumulativeShare(e, ctx, 11, T).toNumber()).toBeCloseTo(1, 10);
  });

  it('ближайший платёж на дату теста: 28 октября, авансы за 9 месяцев', () => {
    const today = { year: 2026, month: 9, day: 10 };
    const eps = nextPayment(incomeTaxSchedule(ent('epsilon'), ctx, {}, T), today)!;
    expect(toIsoDate(eps.due)).toBe('2026-10-28');
    expect(eps.period).toBe('9m');
    eq2(eps.amount, '1540655.74');
  });

  it('в день срока платёж ещё ближайший, на следующий день это итог года', () => {
    const s = incomeTaxSchedule(ent('epsilon'), ctx, {}, T);
    expect(toIsoDate(nextPayment(s, { year: 2026, month: 9, day: 28 })!.due)).toBe('2026-10-28');
    const after = nextPayment(s, { year: 2026, month: 9, day: 29 })!;
    expect(toIsoDate(after.due)).toBe('2027-03-28');
    expect(after.kind).toBe('final');
    expect(nextPayment(s, { year: 2027, month: 2, day: 29 })).toBeNull();
  });

  it('календарь группы на дату теста: УСН, налог на прибыль и три трети НДС', () => {
    const p = groupPayments(SEED_ENTITIES, {}, ctx, T);
    const oct = p.filter((x) => toIsoDate(x.due) === '2026-10-28');
    expect(oct.filter((x) => x.kind === 'usn')).toHaveLength(4);
    expect(oct.filter((x) => x.kind === 'profit')).toHaveLength(1);
    expect(oct.filter((x) => x.kind === 'vat').map((x) => x.vatThird)).toEqual([1, 1, 1]);
    expect(p.filter((x) => x.kind === 'vat').map((x) => toIsoDate(x.due))).toContain('2026-12-28');
    // порядок по срокам
    const dates = p.map((x) => toIsoDate(x.due));
    expect([...dates].sort()).toEqual(dates);
    expect(daysUntil(p[0]!.due, T)).toBe(18);
  });

  it('НДС тремя равными частями: третья часть равна первой', () => {
    const p = groupPayments(SEED_ENTITIES, {}, ctx, T).filter(
      (x) => x.kind === 'vat' && x.entityId === 'epsilon' && x.vatQuarter === 3,
    );
    expect(p).toHaveLength(3);
    expect(p[0]!.amount.eq(p[2]!.amount)).toBe(true);
    // 74 млн × 0,37 × 22/122 × 0,45 / 3
    eq2(p[0]!.amount, '740606.56');
  });

  it('в четвёртом квартале есть и доли за третий, и доли за четвёртый (январь–март следующего года)', () => {
    const p = groupPayments(SEED_ENTITIES, {}, ctx, T).filter((x) => x.kind === 'vat' && x.entityId === 'epsilon');
    expect(p.map((x) => `${toIsoDate(x.due)} ${x.vatQuarter}/${x.vatThird}`)).toEqual([
      '2026-10-28 3/1',
      '2026-11-28 3/2',
      '2026-12-28 3/3',
      '2027-01-28 4/1',
      '2027-02-28 4/2',
      '2027-03-28 4/3',
    ]);
    const q4 = p.filter((x) => x.vatQuarter === 4);
    expect(q4[0]!.amount.eq(q4[2]!.amount)).toBe(true);
    // выручка 4 квартала по весам × 22/122 × (1 − доля закупок) / 3
    const e = ent('epsilon');
    const rev = quarterRevenue(e, ctx, 3, T);
    expect(q4[0]!.amount.toFixed(2)).toBe(taxFor(22, rev, e.inputVatShare, 22).div(3).toFixed(2));
  });

  it('до 28 декабря ближайший платёж НДС за 3 квартал, после 28 декабря первая треть за 4 квартал: в январе, а не в конце марта', () => {
    const vat = (m: ReturnType<typeof moment>) =>
      groupPayments(SEED_ENTITIES, {}, seedCtx(m), m).filter((x) => x.kind === 'vat')[0]!;
    const dec28 = vat(moment(2026, 12, 28, 12));
    expect(`${toIsoDate(dec28.due)} ${dec28.vatQuarter}/${dec28.vatThird}`).toBe('2026-12-28 3/3');
    const dec29 = vat(moment(2026, 12, 29, 12));
    expect(`${toIsoDate(dec29.due)} ${dec29.vatQuarter}/${dec29.vatThird}`).toBe('2027-01-28 4/1');
  });

  it('ближайший срок переходит на следующую дату после 28 октября: 28 ноября, потом 28 декабря', () => {
    const first = (m: ReturnType<typeof moment>) => {
      const list = groupPayments(SEED_ENTITIES, {}, seedCtx(m), m);
      const f = list[0]!;
      return `${toIsoDate(f.due)} ${f.kind}`;
    };
    expect(first(moment(2026, 10, 14, 12))).toBe('2026-10-28 usn');
    expect(first(moment(2026, 10, 28, 23, 59, 0))).toBe('2026-10-28 usn');
    expect(first(moment(2026, 10, 29, 12))).toBe('2026-11-28 vat');
    expect(first(moment(2026, 11, 29, 12))).toBe('2026-12-28 vat');
    expect(first(moment(2026, 12, 20, 12))).toBe('2026-12-28 vat');
    // предупреждение о платеже и блок «Ближайший платёж» на карточках двигаются так же
    const w = (m: ReturnType<typeof moment>) =>
      buildWarnings(SEED_ENTITIES, {}, seedCtx(m), m).find((x) => x.kind === 'payment-date')!;
    expect(w(moment(2026, 10, 14, 12)).title).toContain('28 октября');
    expect(w(moment(2026, 10, 29, 12)).title).toBe('28 ноября: вторая треть НДС за 3 квартал');
    expect(w(moment(2026, 12, 20, 12)).title).toBe('28 декабря: третья треть НДС за 3 квартал');
    const sched = (id: string, m: ReturnType<typeof moment>) =>
      nextPayment(incomeTaxSchedule(ent(id), seedCtx(m), {}, m), { year: m.year, month: m.month, day: m.day });
    expect(toIsoDate(sched('alfa', moment(2026, 10, 28, 12))!.due)).toBe('2026-10-28');
    expect(toIsoDate(sched('alfa', moment(2026, 10, 29, 12))!.due)).toBe('2027-03-28');
    expect(toIsoDate(sched('beta', moment(2026, 10, 29, 12))!.due)).toBe('2027-04-28');
  });
});

describe('предупреждения о платежах и ОСНО', () => {
  const list = buildWarnings(SEED_ENTITIES, {}, ctx, T);
  const nb = (s: string) => s.replace(/ /g, ' ');

  it('информационное: 28 октября авансы и первая треть НДС', () => {
    const w = list.find((x) => x.kind === 'payment-date')!;
    expect(w.level).toBe('info');
    expect(nb(w.title)).toBe(
      '28 октября: авансовые платежи по УСН и налогу на прибыль за 9 месяцев и первая треть НДС за 3 квартал',
    );
    // суммы из календаря: УСН 1 439 194, прибыль 1 540 656, НДС 1 036 607
    expect(nb(w.text)).toContain('УСН 1 439 194 ₽');
    expect(nb(w.text)).toContain('налог на прибыль 1 540 656 ₽');
    expect(nb(w.text)).toContain('НДС 1 036 607 ₽');
  });

  it('информационное: Эпсилон на ОСНО, прогноз налога на прибыль за год', () => {
    const w = list.find((x) => x.kind === 'osno-profit')!;
    expect(w.level).toBe('info');
    expect(nb(w.title)).toBe('ООО «Эпсилон» на ОСНО: прогноз налога на прибыль за год 4,16 млн');
    expect(w.text).toContain('Проверьте с бухгалтером');
    expect(w.text.toLowerCase()).not.toContain('демо');
  });

  it('счётчик: одно срочное, всего семь', () => {
    expect(warningCounter(list)).toBe('Срочных: 1, всего: 7');
  });

  it('тексты предупреждений о порогах не изменились', () => {
    expect(nb(list.find((x) => x.kind === 'threshold-crossing')!.title)).toBe(
      'ИП Дельта пересечёт порог 20 млн около 19 декабря',
    );
    expect(nb(list.find((x) => x.kind === 'unified-business')!.text)).toContain(
      'группа в сумме 77,7 млн за год, это 29% от лимита ставки 5% (272,5 млн)',
    );
  });

  it('напоминание о платежах не показывается, если срок далеко', () => {
    const jan = moment(2026, 1, 12);
    const c = seedCtx(jan);
    expect(buildWarnings(SEED_ENTITIES, {}, c, jan).some((x) => x.kind === 'payment-date')).toBe(false);
  });

  it('деньги: итоги по группе без расхождения в копейку', () => {
    const rounded = SEED_ENTITIES.map((e) => round2(incomeTax(e, ctx, {}, T).forecast));
    // 1 622 857,14 + 832 857,14 + 1 254 000,00 + 180 000,00 + 4 163 934,43
    expect(sum(rounded).toFixed(2)).toBe('8053648.71');
  });
});
