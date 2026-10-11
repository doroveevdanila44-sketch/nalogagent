import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Маршрут /api/chat проверяется настоящим обработчиком и настоящей базой (PGlite): подменён только вход.
const h = vi.hoisted(() => ({ db: null as unknown, userId: '' }));
vi.mock('@/lib/db/client', () => ({ getDb: () => h.db, closeDb: async () => undefined }));
vi.mock('@/lib/auth/server', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireApiAuth: async () => ({ ok: true, auth: { userId: h.userId } }),
    json: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    failure: (_scope: string, e: unknown) => {
      throw e;
    },
  };
});

import { POST } from '@/app/api/chat/route';
import { createOwner } from '@/lib/auth/service';
import { calcTax, mln, momentFromEpoch, type CalcData, type Period } from '@/lib/calc';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { agentState, chatMessages, users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import type { InterpretContext, RawFields } from './interpret';
import type { LlmProvider } from './provider';
import { handleChat, loadHistory } from './service';
import { StubProvider } from './stub';
import { GUARD_FALLBACK, REFUSALS } from './templates';
import { checkNumbers } from './text';
import type { CalcResult, ChatTurn } from './types';

/** 2026-10-10 12:00:00 по Камчатке: та же контрольная дата, что в CALC.md */
const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);
const TZ = 'Asia/Kamchatka';

let db: Db;
let close: () => Promise<void>;
let userId: string;
let data: CalcData;
let clock = NOW;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  await seedDatabase(db);
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
  h.userId = userId;
  data = await loadCalcData(db, momentFromEpoch(NOW, TZ));
});
afterAll(async () => close());

beforeEach(async () => {
  await db.delete(chatMessages);
  await db.update(agentState).set({ refusalIndex: 0, greetIndex: 0, lastActive: null });
});

/** Каждое сообщение через минуту после предыдущего: порядок в ленте и «сессия» как у живого чата. */
async function ask(question: string, opts: { baseId?: number; provider?: LlmProvider } = {}): Promise<ChatTurn> {
  clock += 60_000;
  const res = await handleChat(db, { userId, question, nowMs: clock, baseId: opts.baseId, provider: opts.provider });
  return res.agent;
}

const month = (m: number): Period => ({ kind: 'month', year: 2026, month: m });
const calc = (tax: 'vat' | 'usn' | 'profit', period: Period, ids: string[] | 'all' = 'all') =>
  calcTax({ entityIds: ids, tax, period }, data);
const plain = (s: string) => s.replace(/[  ]/g, ' ');
const rowOf = (t: ChatTurn, name: string) => t.tables[0]!.rows.find((r) => r[0]!.startsWith(name))!;

describe('результат по существу вопроса', () => {
  it('«расчёт за февраль» даёт февральские цифры, а не годовые', async () => {
    const r = await ask('расчёт за февраль');
    const feb = calc('vat', month(2));
    const year = calc('vat', { kind: 'year', year: 2026 });

    expect(r.class).toBe('A');
    expect(r.fromCalc).toBe(true);
    expect(r.text).toContain('НДС за февраль 2026');
    expect(r.text).toContain(mln(feb.total!, 2));
    expect(r.text).not.toContain(mln(year.total!, 2));
    expect(r.text).not.toContain('за год');

    // таблица: по юрлицам и итог за февраль
    expect(r.tables[0]!.head).toEqual(['Юрлицо', 'Выручка', 'НДС']);
    expect(rowOf(r, 'ООО «Альфа»')[2]).toBe(mln(feb.entities.find((e) => e.entityId === 'alfa')!.tax!, 2));
    expect(r.tables[0]!.rows.at(-1)).toEqual(['Всего', mln(feb.revenue!, 2), mln(feb.total!, 2)]);
    // ближайший платёж
    expect(plain(r.text)).toContain('Ближайший платёж по НДС 28 октября: первая треть за 3 квартал, 1 036 607 ₽.');
    // в «Как посчитано» формула месяца и источник
    expect(plain(r.how.join(' '))).toContain('НДС 5%: выручка 1 988 000 ₽ × 5 / 105 = 94 666,67 ₽');
    expect(plain(r.how.join(' '))).toContain('Источник: Выгрузка из 1С (демо), загружена 10 октября 2026, 18:00');
  });

  it('карточка «Понял так» с тремя значениями и пометкой', async () => {
    const r = await ask('расчёт за февраль');
    expect(r.understood).toEqual({
      entity: 'Вся группа',
      tax: 'НДС',
      period: 'февраль 2026',
      kind: 'fact',
      kindLabel: 'факт',
      notes: ['налог не назван, считаю НДС'],
    });
    expect(r.change!.tax.map((q) => q.label)).toEqual(['НДС', 'УСН', 'Налог на прибыль']);

    const named = await ask('НДС по Альфе за октябрь');
    expect(named.understood).toMatchObject({
      entity: 'ООО «Альфа»',
      tax: 'НДС',
      period: 'октябрь 2026',
      kindLabel: 'факт и прогноз',
      notes: [],
    });
    const fc = await ask('НДС за ноябрь');
    expect(fc.understood!.kindLabel).toBe('прогноз');
  });

  it('«НДС Альфа 2 квартал» даёт второй квартал', async () => {
    const r = await ask('НДС Альфа 2 квартал');
    const q2 = calc('vat', { kind: 'quarter', year: 2026, quarter: 2 }, ['alfa']);
    expect(r.understood).toMatchObject({ entity: 'ООО «Альфа»', tax: 'НДС', period: '2 квартал 2026' });
    expect(r.text).toContain('НДС за 2 квартал 2026 по ООО «Альфа»');
    expect(r.text).toContain(mln(q2.total!, 2));
    // без юрлица группы в ответе нет, кнопок сужения тоже
    expect(r.tables[0]!.rows).toHaveLength(1);
    expect(r.quick).toEqual([]);
    expect(r.text).not.toContain('по всей группе');
    // помесячная таблица квартала
    const months = r.tables[1]!;
    expect(months.head).toEqual(['Месяц', 'НДС', 'Основа']);
    expect(months.rows.map((x) => x[0])).toEqual(['апрель 2026', 'май 2026', 'июнь 2026', 'Всего']);
  });

  it('за квартал квартал, за год годовой прогноз только на вопрос про год', async () => {
    const q = await ask('НДС за 1 квартал');
    expect(q.text).toContain(mln(calc('vat', { kind: 'quarter', year: 2026, quarter: 1 }).total!, 2));
    const y = await ask('сколько НДС за год');
    expect(y.text).toContain('НДС за год по группе');
    expect(y.text).toContain(mln(calc('vat', { kind: 'year', year: 2026 }).total!, 2));
    const m = await ask('налог за март');
    expect(m.text).not.toContain('за год');
    expect(m.text).toContain(mln(calc('vat', month(3)).total!, 2));
  });

  it('УСН и налог на прибыль за месяц и за с начала года', async () => {
    const usn = await ask('УСН по Бете за август');
    const aug = calc('usn', month(8), ['beta']);
    expect(usn.text).toContain(`Налог по УСН за август 2026 по ИП Бета: ${mln(aug.total!, 2)}`);
    expect(usn.tables[0]!.head).toEqual(['Юрлицо и режим', 'За август 2026', 'Ближайший платёж']);

    const profit = await ask('налог на прибыль Эпсилон с начала года');
    const ytd = calc('profit', { kind: 'ytd' }, ['epsilon']);
    expect(profit.text).toContain(mln(ytd.total!, 2));
    expect(profit.understood).toMatchObject({ entity: 'ООО «Эпсилон»', tax: 'Налог на прибыль', period: 'с начала года' });
  });

  it('налог не для режима юрлица: показан налог его режима и сказано об этом', async () => {
    const r = await ask('УСН по Эпсилон за март');
    expect(r.text).toContain('ООО «Эпсилон» на ОСНО, налога по УСН нет, показан налог на прибыль.');
    expect(rowOf(r, 'ООО «Эпсилон»')[0]).toContain('ОСНО, 25%');
  });

  it('ставка из вопроса уходит в расчёт', async () => {
    const r = await ask('сколько НДС за февраль по ставке 22%');
    const want = calcTax({ entityIds: 'all', tax: 'vat', period: month(2), rate: 22 }, data);
    expect(r.text).toContain(`по ставке 22%: ${mln(want.total!, 2)}`);
    expect(r.understood!.tax).toBe('НДС, ставка 22%');
  });
});

describe('уточнения', () => {
  it('неоднозначное «сколько платить» вызывает один вопрос с кнопками', async () => {
    const r = await ask('сколько платить');
    expect(r.fromCalc).toBe(false);
    expect(r.tables).toEqual([]);
    expect(r.understood).toBeNull();
    expect(r.text).toBe('Какой налог и за какой период посчитать?');
    expect(r.quick.map((q) => q.label)).toEqual([
      'НДС', 'УСН', 'Налог на прибыль', 'С начала года', 'Октябрь', '3 квартал', '2026 год',
    ]);
  });

  it('ответ «февраль» после вопроса про НДС объединяется с прежним вопросом', async () => {
    const q = await ask('сколько НДС платить');
    expect(q.text).toBe('За какой период посчитать НДС?');
    expect(q.quick.map((x) => x.label)).toContain('Октябрь');

    const a = await ask('февраль');
    expect(a.fromCalc).toBe(true);
    expect(a.understood).toMatchObject({ tax: 'НДС', period: 'февраль 2026', notes: [] });
    expect(a.text).toContain(mln(calc('vat', month(2)).total!, 2));
    // вопрос не повторяется
    expect(a.text).not.toContain('За какой период');
  });

  it('налог и период по очереди: кнопка и сообщение дают тот же результат', async () => {
    const first = await ask('сколько платить');
    const second = await ask('налог на прибыль', { baseId: first.id });
    expect(second.text).toBe('За какой период посчитать налог на прибыль?');
    const third = await ask('с начала года', { baseId: second.id });
    expect(third.understood).toMatchObject({ tax: 'Налог на прибыль', period: 'с начала года' });
    expect(third.text).toContain('с начала года');
  });

  it('если юрлицо не названо: посчитано по группе, сказано об этом, есть кнопки сужения', async () => {
    const r = await ask('НДС за август');
    expect(r.text).toContain('Юрлицо не названо, посчитал по всей группе.');
    expect(r.quick.map((q) => q.label)).toEqual(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);

    // нажатие «Бета» продолжает тот же вопрос
    const narrow = await ask('по Бете', { baseId: r.id });
    expect(narrow.understood).toMatchObject({ entity: 'ИП Бета', tax: 'НДС', period: 'август 2026' });
    expect(narrow.text).toContain(mln(calc('vat', month(8), ['beta']).total!, 2));
  });

  it('«по группе» сказано явно: примечания нет, кнопки сужения остались', async () => {
    const r = await ask('НДС по группе за август');
    expect(r.text).not.toContain('Юрлицо не названо');
    expect(r.understood!.entity).toBe('Вся группа');
    expect(r.quick).toHaveLength(5);
  });

  it('ставки, пороги и сценарий тоже с карточкой, вычет без неё', async () => {
    const rates = await ask('Какая ставка выгоднее?');
    expect(rates.understood).toMatchObject({
      entity: 'Вся группа',
      tax: 'НДС',
      period: '2026 год',
      kindLabel: 'факт и прогноз',
    });
    expect(rates.quick).toHaveLength(5);
    const one = await ask('а по Бете?');
    expect(one.understood!.entity).toBe('ИП Бета');
    expect(one.quick).toEqual([]);
    const warn = await ask('Что с порогами?');
    expect(warn.understood!.period).toBe('2026 год');
    const deduct = await ask('Объясни вычет');
    expect(deduct.understood).toBeNull();
    expect(deduct.fromCalc).toBe(true);
  });

  it('«Изменить»: налог меняется, период и юрлицо остаются, даже если ответ не последний', async () => {
    const first = await ask('расчёт за февраль по Бете');
    await ask('что с порогами?');
    const changed = await ask('УСН', { baseId: first.id });
    expect(changed.understood).toMatchObject({ entity: 'ИП Бета', tax: 'УСН', period: 'февраль 2026' });
    expect(changed.text).toContain(mln(calc('usn', month(2), ['beta']).total!, 2));
  });

  it('«а за март?» после расчёта меняет только период', async () => {
    await ask('УСН по Бете за февраль');
    const r = await ask('а за март?');
    expect(r.understood).toMatchObject({ entity: 'ИП Бета', tax: 'УСН', period: 'март 2026' });
  });

  it('вопрос по другой теме после уточнения не склеивается с прежним', async () => {
    const q = await ask('налог на прибыль');
    expect(q.text).toBe('За какой период посчитать налог на прибыль?');
    // вместо ответа пользователь спросил про пороги
    const other = await ask('что с порогами?');
    expect(other.text).toContain('предупрежд');
    expect(other.understood).toMatchObject({ tax: 'НДС' });
  });
});

describe('пояснения вместо общего отказа', () => {
  const canDo = 'Что могу сейчас:';

  it('«налог за 2027»: лимиты не утверждены, жду дефлятор', async () => {
    const r = await ask('налог за 2027');
    expect(r.fromCalc).toBe(false);
    expect(r.text).toContain('Лимиты 2027 пока не утверждены, жду дефлятор.');
    expect(r.text).toContain('Данные в демо с января 2025 по декабрь 2026');
    expect(r.text).toContain(canDo);
    expect(r.tables).toEqual([]);
  });

  it('период вне данных: до 2025 и после 2026', async () => {
    for (const q of ['налог за 2024 год', 'НДС за март 2023', 'расчёт за 2028 год']) {
      const r = await ask(q);
      expect(r.text, q).toContain('Данные в демо с января 2025 по декабрь 2026');
      expect(r.text, q).toContain(canDo);
      expect(r.fromCalc, q).toBe(false);
    }
  });

  it('налог не из списка', async () => {
    for (const q of ['НДФЛ за март', 'страховые взносы за год', 'ЕНВД по Бете', 'налог на имущество за 2026']) {
      const r = await ask(q);
      expect(r.text, q).toContain('я не считаю');
      expect(r.text, q).toContain('Считаю НДС, налог по УСН и налог на прибыль');
      expect(r.text, q).toContain(canDo);
      expect(r.quick.map((x) => x.label), q).toEqual(['НДС', 'УСН', 'Налог на прибыль']);
    }
  });

  it('юрлицо не из группы', async () => {
    const r = await ask('налог по ООО Ромашка за февраль');
    expect(r.text).toContain('ООО Ромашка нет в группе.');
    expect(r.text).toContain('ООО «Альфа», ИП Бета, ИП Дельта, ООО «Гамма», ООО «Эпсилон»');
    expect(r.text).toContain(canDo);
    expect(r.quick.length).toBeGreaterThan(0);
  });

  it('юридическая оценка схем: отказ из набора по кругу, строка «Что могу сейчас» после него', async () => {
    const got: string[] = [];
    for (const q of ['законно ли делить бизнес на несколько ИП?', 'можно ли так, это легально?', 'оцени схему с точки зрения закона']) {
      const r = await ask(q);
      expect(r.class).toBe('D');
      expect(r.text).toContain(canDo);
      got.push(r.text.split('\n\n')[0]!);
    }
    expect(got).toEqual([REFUSALS[0], REFUSALS[1], REFUSALS[2]]);
    const [s] = await db.select().from(agentState).where(eq(agentState.userId, userId));
    expect(s!.refusalIndex).toBe(3);
  });

  it('в пояснениях нет чисел и длинных тире, кроме нужных годов', async () => {
    const r = await ask('налог за 2027');
    expect(r.text).not.toMatch(/[‒-―−]/);
    const canDoLine = r.text.split('\n\n').at(-1)!;
    expect(canDoLine).not.toMatch(/\d/);
  });

  it('прежняя граница продукта осталась: как раздробить', async () => {
    const r = await ask('Как раздробить бизнес?');
    expect(r.class).toBe('F');
    expect(r.text).toContain('Такие схемы я не проектирую');
  });
});

describe('нет правил на год и нет данных', () => {
  it('2025 год: выручка есть, налога нет, сказано почему', async () => {
    const r = await ask('НДС за 2025 год');
    expect(r.fromCalc).toBe(true);
    expect(r.text).toContain('НДС за 2025 год по группе не рассчитан.');
    expect(r.text).toContain('Нет правил на 2025 год');
    expect(r.text).toContain('Что могу сейчас:');
    expect(r.understood).toMatchObject({ period: '2025 год', kindLabel: 'факт' });
  });
});

describe('история хранит понимание', () => {
  it('карточка, кнопки и варианты возвращаются из базы', async () => {
    await ask('расчёт за февраль');
    const history = await loadHistory(db, userId);
    const agent = history.at(-1)!;
    expect(agent.understood?.period).toBe('февраль 2026');
    expect(agent.quick).toHaveLength(5);
    expect(agent.change?.period).toHaveLength(4);
    const user = history.at(-2)!;
    expect(user.understood).toBeNull();
    expect(user.quick).toEqual([]);
  });
});

describe('числа только из расчёта', () => {
  it('в тексте ответов нет чисел вне расчёта, вопроса и карточки', async () => {
    const questions = [
      'расчёт за февраль', 'НДС Альфа 2 квартал', 'УСН по Бете за август', 'налог на прибыль за год?',
      'сколько НДС за год', 'когда платить НДС', 'налог за ноябрь по Эпсилон', 'НДС с начала года',
    ];
    for (const q of questions) {
      const r = await ask(q);
      const sources = [
        ...r.tables.flatMap((t) => [...t.head, ...t.rows.flat()]),
        ...r.how,
        q,
        r.understood ? Object.values(r.understood).flat().join(' ') : '',
      ];
      const check = checkNumbers(r.text, sources);
      expect(check.unknown, q).toEqual([]);
    }
  });

  it('предохранитель действует и на ответы о сумме: чужое число не уходит', async () => {
    class Lying extends StubProvider {
      override async explain(result: CalcResult): Promise<string> {
        return `${result.paragraphs[0]} Вы переплатите 12 345 678 ₽.`;
      }
    }
    const r = await ask('расчёт за февраль', { provider: new Lying() });
    expect(r.text).toBe(GUARD_FALLBACK);
    expect(r.fromCalc).toBe(false);
    expect(r.understood).toBeNull();
  });
});

describe('провайдер модели только извлекает поля', () => {
  /** Имитация модели: поля из «ответа модели», числа считает calcTax, слова модель только пересказывает. */
  class FakeModel implements LlmProvider {
    readonly name = 'fake-model';
    calls = 0;
    private stub = new StubProvider();
    parse = this.stub.parse.bind(this.stub);
    async explain(result: CalcResult): Promise<string> {
      return result.paragraphs.join('\n\n');
    }
    async extract(_q: string, _ctx: InterpretContext): Promise<Partial<RawFields>> {
      this.calls++;
      return {
        entities: ['beta', 'нет-такого'],
        taxes: ['vat'],
        periods: [{ period: { kind: 'month', year: 2026, month: 5 } }],
        fragment: false,
      };
    }
  }

  it('поля модели превращаются в тот же расчёт, что у заглушки', async () => {
    const model = new FakeModel();
    const r = await ask('вот это посчитай, пожалуйста', { provider: model });
    expect(model.calls).toBe(1);
    expect(r.understood).toMatchObject({ entity: 'ИП Бета', tax: 'НДС', period: 'май 2026' });
    expect(r.text).toContain(mln(calc('vat', month(5), ['beta']).total!, 2));
  });

  it('мусор от модели не ломает ответ: непонятное поле отбрасывается, недостающее спрашивается', async () => {
    class Junk extends FakeModel {
      override async extract(): Promise<Partial<RawFields>> {
        return { entities: ['zzz'], taxes: ['excise' as 'vat'], periods: [{ period: { kind: 'month', year: 2026, month: 99 } }] };
      }
    }
    const r = await ask('посчитай как-нибудь налог', { provider: new Junk() });
    expect(r.fromCalc).toBe(false);
    expect(r.text).toBe('Какой налог и за какой период посчитать?');
  });
});

describe('маршрут /api/chat принимает номер ответа', () => {
  async function post(body: unknown) {
    const req = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    return { status: res.status, json: (await res.json()) as { agent?: ChatTurn; user?: ChatTurn; code?: string } };
  }

  it('сообщение с baseId продолжает прежний ответ', async () => {
    const first = await post({ message: 'расчёт за февраль' });
    expect(first.status).toBe(200);
    const id = first.json.agent!.id;
    const second = await post({ message: 'УСН', baseId: id });
    expect(second.status).toBe(200);
    expect(second.json.agent!.understood).toMatchObject({ tax: 'УСН', period: 'февраль 2026' });
  });

  it('чужой или несуществующий номер не ломает запрос и ничего не склеивает с «Изменить»', async () => {
    const r = await post({ message: 'УСН', baseId: 999999 });
    expect(r.status).toBe(200);
    // нет прежнего вопроса: спрашивается период
    expect(r.json.agent!.text).toBe('За какой период посчитать налог по УСН?');
  });

  it('неверный baseId отклоняется', async () => {
    expect((await post({ message: 'УСН', baseId: -1 })).status).toBe(400);
    expect((await post({ message: 'УСН', baseId: 'x' })).status).toBe(400);
  });
});
