import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwner } from '@/lib/auth/service';
import {
  buildWarnings,
  calcTax,
  computeStatic,
  crossing,
  dashboardInput,
  dec,
  groupPayments,
  moment,
  momentFromEpoch,
  monthlySeries,
  sumKind,
  type EntityInput,
  type Moment,
} from '@/lib/calc';
import { SEED_ENTITIES, seedCtx } from '@/lib/calc/demo-data';
import { toIsoDate } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { checkDateOrder, fillFields, normalizeInput, FieldError } from '@/lib/documents/fill';
import type { TemplateField } from '@/lib/documents/types';

/**
 * Результаты экспресс-аудита (AUDIT.md): сквозные проверки между экранами и датами. Здесь собраны
 * проверки, которые не относятся к одному модулю: цифры дашборда и платежей против расчёта, поведение
 * на 14 и 29 октября, 20 декабря, правила и даты в предупреждениях, поля документов.
 */

const TZ = 'Asia/Kamchatka';
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 0);
const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db);
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
});
afterAll(async () => close());

describe('платежи НДС и расчёт квартала дают одни и те же суммы', () => {
  for (const [label, ms] of [
    ['14 октября', at(2026, 10, 14)],
    ['29 октября', at(2026, 10, 29)],
    ['20 декабря', at(2026, 12, 20)],
  ] as const) {
    it(`${label}: три доли платежа за квартал равны НДС квартала из calcTax (3 и 4 квартал)`, async () => {
      const today = momentFromEpoch(ms, TZ);
      const data = await loadCalcData(db, today);
      const input = dashboardInput(data);
      const pays = groupPayments(input.entities, input.selections, input.ctx, today);
      for (const e of input.entities.filter((x) => x.status === 'payer')) {
        for (const quarter of [3, 4] as const) {
          const thirds = pays.filter((p) => p.kind === 'vat' && p.entityId === e.id && p.vatQuarter === quarter);
          const r = calcTax({ entityIds: [e.id], tax: 'vat', period: { kind: 'quarter', year: 2026, quarter } }, data);
          // 3 квартал после 28 октября уже платится частями: считаются только оставшиеся доли
          const full = thirds.length === 3;
          if (full) {
            const total = thirds.reduce((a, p) => a.plus(p.amount), dec(0));
            expect(total.toFixed(2), `${e.id} ${quarter} квартал`).toBe(r.total!.toFixed(2));
          } else {
            for (const p of thirds) expect(p.amount.times(3).toFixed(2)).toBe(r.total!.toFixed(2));
          }
        }
      }
    });
  }

  it('предупреждение о платеже называет ту же сумму, что календарь платежей на эту дату', () => {
    for (const m of [moment(2026, 10, 14, 12), moment(2026, 10, 29, 12), moment(2026, 12, 20, 12)]) {
      const ctx = seedCtx(m);
      const first = groupPayments(SEED_ENTITIES, {}, ctx, m)[0]!;
      const same = groupPayments(SEED_ENTITIES, {}, ctx, m).filter((p) => toIsoDate(p.due) === toIsoDate(first.due));
      const w = buildWarnings(SEED_ENTITIES, {}, ctx, m).find((x) => x.kind === 'payment-date')!;
      const total = same.reduce((a, p) => a.plus(p.amount), dec(0));
      const rub = nb(total.toDecimalPlaces(0).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
      expect(nb(w.text), toIsoDate(m)).toContain(`Всего ${rub} ₽`);
      expect(sumKind(same, 'vat', first.due).gte(0)).toBe(true);
    }
  });
});

describe('даты в предупреждениях и на графике', () => {
  const rich: EntityInput = { ...SEED_ENTITIES.find((e) => e.id === 'delta')!, annualRevenue: dec(60_000_000) };

  it('20 декабря Дельта «уже пересёк порог (19 декабря)», НДС начнётся с 1 января 2027', () => {
    const m = moment(2026, 12, 20, 12);
    const w = buildWarnings(SEED_ENTITIES, {}, seedCtx(m), m).find((x) => x.kind === 'threshold-crossing')!;
    expect(nb(w.title)).toBe('ИП Дельта уже пересёк порог 20 млн (19 декабря)');
    expect(nb(w.text)).toContain('НДС начнёт начисляться с 1 января 2027.');
  });

  it('первое число месяца после пересечения уже прошло: «начисляется», а не «начнёт начисляться»', () => {
    const m = moment(2026, 11, 5, 12);
    const w = buildWarnings([rich], {}, seedCtx(m), m).find((x) => x.kind === 'threshold-crossing')!;
    expect(nb(w.title)).toBe('ИП Дельта уже пересёк порог 20 млн (5 июня)');
    expect(nb(w.text)).toContain('НДС начисляется с 1 июля.');
    expect(w.text).not.toContain('начнёт');
  });

  it('до пересечения предупреждение в будущем времени', () => {
    const m = moment(2026, 10, 14, 12);
    const w = buildWarnings(SEED_ENTITIES, {}, seedCtx(m), m).find((x) => x.kind === 'threshold-crossing')!;
    expect(nb(w.title)).toBe('ИП Дельта пересечёт порог 20 млн около 19 декабря');
  });

  it('срок в следующем году называется с годом: «28 марта 2027», а не «28 марта»', () => {
    const m = moment(2026, 10, 29, 12);
    const list = buildWarnings(SEED_ENTITIES, {}, seedCtx(m), m);
    expect(nb(list.find((x) => x.kind === 'osno-profit')!.text)).toContain('Ближайший платёж 28 марта 2027,');
    // а в текущем году год не пишется
    const early = moment(2026, 10, 14, 12);
    expect(nb(buildWarnings(SEED_ENTITIES, {}, seedCtx(early), early).find((x) => x.kind === 'osno-profit')!.text)).toContain(
      'Ближайший платёж 28 октября,',
    );
  });

  it('после 28 декабря ближайшее предупреждение о платеже: первая треть НДС за 4 квартал 28 января 2027', () => {
    const m = moment(2026, 12, 29, 12);
    const w = buildWarnings(SEED_ENTITIES, {}, seedCtx(m), m).find((x) => x.kind === 'payment-date')!;
    expect(nb(w.title)).toBe('28 января 2027: первая треть НДС за 4 квартал');
  });

  it('месяцы без факта в источнике на графике «прогноз», а не «факт»; сентябрь «факт», идущий месяц «идёт»', async () => {
    const statuses = async (m: Moment) => {
      const input = dashboardInput(await loadCalcData(db, m));
      return monthlySeries(input.entities, input.ctx, m).map((c) => c.status);
    };
    expect(await statuses(moment(2026, 12, 20, 12))).toEqual([
      'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'forecast', 'forecast', 'current',
    ]);
    expect((await statuses(moment(2026, 10, 14, 12))).slice(8, 12)).toEqual(['fact', 'current', 'forecast', 'forecast']);
    expect((await statuses(moment(2026, 10, 29, 12))).slice(8, 12)).toEqual(['fact', 'current', 'forecast', 'forecast']);
  });

  it('дата пересечения Дельтой 19 декабря одна и та же на 14 октября, 29 октября, 19 и 20 декабря', () => {
    for (const m of [moment(2026, 10, 14, 12), moment(2026, 10, 29, 12), moment(2026, 12, 19, 12), moment(2026, 12, 20, 12)]) {
      const e = SEED_ENTITIES.find((x) => x.id === 'delta')!;
      expect(toIsoDate(crossing(e, seedCtx(m), m)!), toIsoDate(m)).toBe('2026-12-19');
    }
  });

  it('месяц начала НДС после пересечения не уезжает вперёд со сменой месяца', () => {
    // граница месяцев: 31 октября накопление достигает порога
    const monthShare = (e: EntityInput, m: Moment) => computeStatic(dashboardInputFor([e], m), m).perEntity[e.id]!.baseRev;
    const e: EntityInput = { ...rich, id: 'rich' };
    const a = monthShare(e, moment(2026, 10, 14, 12));
    const b = monthShare(e, moment(2026, 11, 14, 12));
    const c = monthShare(e, moment(2026, 12, 14, 12));
    expect(b.toFixed(2)).toBe(a.toFixed(2));
    expect(c.toFixed(2)).toBe(a.toFixed(2));
  });
});

function dashboardInputFor(entities: EntityInput[], m: Moment) {
  return { entities, selections: {}, ctx: seedCtx(m) };
}

describe('поля документов: даты и порядок дат', () => {
  const dateField: TemplateField = { key: 'd', label: 'Дата', type: 'date', source: 'user', required: true };

  it('несуществующие даты не принимаются: 30 февраля, 31 апреля, 29 февраля 2027', () => {
    for (const bad of ['2026-02-30', '2026-04-31', '2027-02-29', '2026-06-31', '2026-13-01', '2026-00-10', '1800-01-01']) {
      expect(() => normalizeInput(dateField, bad), bad).toThrow(FieldError);
    }
  });

  it('настоящие даты принимаются, в том числе 29 февраля високосного года', () => {
    for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31', '2026-01-01']) {
      expect(normalizeInput(dateField, ok), ok).toBe(ok);
    }
  });

  it('дата соглашения раньше даты договора: ошибка у поля «Дата соглашения»', () => {
    const v = (a: string, c: string) => ({
      addendum_date: { value: a, display: a, source: 'user' as const },
      contract_date: { value: c, display: c, source: 'user' as const },
    });
    expect(() => checkDateOrder(v('2026-03-01', '2026-04-01'))).toThrow('Дата соглашения: не может быть раньше даты договора');
    expect(() => checkDateOrder(v('2026-04-01', '2026-04-01'))).not.toThrow();
    expect(() => checkDateOrder(v('2026-05-01', '2026-04-01'))).not.toThrow();
    // одной из дат нет: нечего сравнивать
    expect(() => checkDateOrder({ addendum_date: { value: '2026-03-01', display: '', source: 'user' } })).not.toThrow();
  });

  it('fillFields с обратным порядком дат отказывает, с верным заполняет', () => {
    const fields: TemplateField[] = [
      { key: 'contract_date', label: 'Дата договора', type: 'date', source: 'user', required: true },
      { key: 'addendum_date', label: 'Дата соглашения', type: 'date', source: 'user', required: true },
    ];
    expect(() =>
      fillFields(fields, { entity: null, snaps: [], user: { contract_date: '2026-05-01', addendum_date: '2026-04-01' } }),
    ).toThrow(FieldError);
    const ok = fillFields(fields, { entity: null, snaps: [], user: { contract_date: '2026-04-01', addendum_date: '2026-05-01' } });
    expect(ok.addendum_date!.value).toBe('2026-05-01');
  });
});
