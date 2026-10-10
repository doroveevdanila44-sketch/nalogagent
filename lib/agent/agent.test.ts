import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwner } from '@/lib/auth/service';
import { momentFromEpoch } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadDashboardInput } from '@/lib/db/queries';
import { seedDatabase } from '@/lib/db/seed';
import { agentState, chatMessages, llmUsage, users } from '@/lib/db/schema';
import { createTestDb } from '@/lib/db/testing';
import { resultSources } from './answers';
import { aliasesFor, runPipeline } from './pipeline';
import type { LlmProvider } from './provider';
import { StubProvider } from './stub';
import { GUARD_FALLBACK, REFUSALS } from './templates';
import { checkNumbers, extractNumbers } from './text';
import { handleChat, loadHistory } from './service';
import type { CalcResult, EntityRef, ParseContext, ParsedIntent } from './types';

/** 2026-10-10 12:00:00 по Камчатке (UTC+12) */
const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db, { year: 2026, month: 10 });
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = await db.select({ id: users.id }).from(users).limit(1) as [{ id: string }];
});
afterAll(async () => close());

async function ask(q: string, provider?: LlmProvider, at = NOW) {
  const res = await handleChat(db, { userId, question: q, nowMs: at, provider });
  return res.agent;
}

describe('отказы по кругу', () => {
  it('десять формулировок идут по порядку и не повторяются подряд', async () => {
    await db.delete(chatMessages);
    await db.update(agentState).set({ refusalIndex: 0 });
    const off = ['Какая погода?', 'Расскажи анекдот', 'Дай рецепт борща', 'Напиши стих', 'Кто выиграл в футбол', 'Покажи кино',
      'Расскажи сказку', 'Какой курс доллара', 'Гороскоп на завтра', 'Спой песню', 'Какая погода завтра', 'Дай рецепт пиццы'];
    const got: string[] = [];
    for (const q of off) got.push((await ask(q)).text);
    for (let i = 0; i < off.length; i++) expect(got[i]).toBe(REFUSALS[i % 10]);
    for (let i = 1; i < got.length; i++) expect(got[i]).not.toBe(got[i - 1]);
    // индекс хранится по пользователю в базе
    const [s] = await db.select().from(agentState).where(eq(agentState.userId, userId));
    expect(s!.refusalIndex).toBe(12);
  });
});

describe('ответы по расчёту на дату теста', () => {
  it('ставки: числа таблицы совпадают с контрольными', async () => {
    const r = await ask('Какая ставка выгоднее?');
    expect(r.class).toBe('A');
    expect(r.fromCalc).toBe(true);
    const rows = Object.fromEntries(r.tables[0]!.rows.map((x) => [x[0], x.slice(1).map((c) => c.replace(/ /g, ' '))]));
    expect(rows['ООО «Альфа»']).toEqual(['1,35 млн', '1,86 млн', '0,92 млн']);
    expect(rows['ИП Бета']).toEqual(['1,05 млн', '1,44 млн', '2,62 млн']);
    // освобождённые: налог при переходе порога (звёздочка)
    expect(rows['ИП Дельта*']).toEqual(['1,00 млн', '1,37 млн', '3,09 млн']);
    expect(rows['ООО «Гамма»*']).toEqual(['0,30 млн', '0,42 млн', '0,23 млн']);
    expect(r.text).toContain('переплата составляет около 0,43');
  });

  it('квартал: сроки платежей тремя частями до 28 числа', async () => {
    const r = await ask('Сколько платить за квартал?');
    expect(r.text).toContain('до 28 числа трёх месяцев после квартала');
    expect(r.text).toContain('28 октября');
    expect(r.tables[0]!.rows.at(-1)![0]).toBe('Всего за 4 квартал');
  });

  it('пороги: Дельта пересечёт 20 млн, срочное предупреждение', async () => {
    const r = await ask('Что с порогами?');
    expect(r.text).toContain('ИП Дельта пересечёт порог 20');
    expect(r.text.replace(/ /g, ' ')).toContain('около 19 декабря');
  });

  it('сценарий покупки машин: пересчёт доли закупок и налога по 22%', async () => {
    const r = await ask('Что если Альфа купит 3 машины по 7 млн?');
    const t = r.text.replace(/ /g, ' ');
    expect(t).toContain('ООО «Альфа» покупает 3 машины по 7 млн ₽ с НДС, всего 21,0 млн');
    // входной НДС = 21 млн × 22/122 = 3 786 885 ₽
    expect(t).toContain('3 786 885 ₽');
    // доля 0,82 + 21 / 28,4 = 1,559 → 156%
    expect(t).toContain('до 156%');
    expect(r.tables[0]!.head).toEqual(['Ставка за год', 'До', 'После']);
  });

  it('налог на прибыль: честный отказ с планом на 2028', async () => {
    const r = await ask('А налог на прибыль считаешь?');
    expect(r.text).toContain('2028');
  });

  it('вычет: граница около 73,6%', async () => {
    const r = await ask('Объясни вычет входного НДС');
    expect(r.text).toContain('73,6%');
  });
});

describe('уточнение при неполных данных', () => {
  it('без юрлица и цифр спрашивает один раз обо всём и продолжает по ответам', async () => {
    const q1 = await ask('Что если купим машины?');
    expect(q1.text).toContain('по какому юрлицу, сколько машин и по какой цене');
    const q2 = await ask('по Бете');
    expect(q2.text).toContain('сколько машин и по какой цене');
    const q3 = await ask('2 машины по 5 млн');
    expect(q3.fromCalc).toBe(true);
    expect(q3.text).toContain('ИП Бета покупает 2 машины по 5 млн');
  });

  it('«а по Бете?» после ставок повторяет прошлое намерение для другого юрлица', async () => {
    await ask('Какая ставка выгоднее?');
    const r = await ask('а по Бете?');
    expect(r.fromCalc).toBe(true);
    expect(r.tables[0]!.rows).toHaveLength(1);
    expect(r.tables[0]!.rows[0]![0]).toBe('ИП Бета');
  });
});

describe('этикет и служебное без токенов', () => {
  it('приветствие по времени суток клиента (Камчатка)', async () => {
    await db.delete(chatMessages);
    await db.update(agentState).set({ lastActive: null });
    const morning = Date.UTC(2026, 9, 9, 21, 0, 0); // 09:00 по Камчатке
    expect((await ask('Привет', undefined, morning)).text).toBe('Доброе утро. Готов считать.');
  });

  it('токены не расходуются на классы B-F', async () => {
    const before = (await db.select().from(llmUsage)).length;
    await ask('Спасибо');
    await ask('Что ты умеешь?');
    await ask('Какая погода?');
    await ask('Как раздробить бизнес?');
    expect((await db.select().from(llmUsage)).length).toBe(before);
  });
});

describe('предохранитель', () => {
  it('чужое число в ответе модели: ответ не уходит, сбой в журнале', async () => {
    class Lying extends StubProvider {
      override async explain(result: CalcResult): Promise<string> {
        return `${result.paragraphs[0]} Итого вы переплатите 12 345 678 ₽.`;
      }
    }
    const before = (await db.select().from(llmUsage)).length;
    const r = await ask('Какая ставка выгоднее?', new Lying());
    expect(r.text).toBe(GUARD_FALLBACK);
    expect(r.fromCalc).toBe(false);
    expect(r.tables).toHaveLength(0);
    const usage = await db.select().from(llmUsage);
    expect(usage.length).toBe(before + 1);
    expect(usage.at(-1)!.ok).toBe(false);
    expect(usage.at(-1)!.note).toContain('12345678');
  });

  it('числа в другой записи (млн вместо рублей) допустимы', () => {
    const check = checkNumbers('Около 1,35 млн в год', ['Налог 1 352 381 ₽']);
    expect(check.ok).toBe(true);
  });

  it('разделители разрядов и минус нормализуются', () => {
    expect(extractNumbers('−1 352 381,50 ₽')).toEqual(['1352381.5']);
  });
});

// ===== Общий набор тестов провайдера: заглушка и «модель» идут через один интерфейс =====

/** Имитация языковой модели: разбирает вопрос по-своему и пересказывает результат. */
class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  private stub = new StubProvider();
  async parse(q: string, ctx: ParseContext): Promise<ParsedIntent> {
    return this.stub.parse(q, ctx);
  }
  async explain(result: CalcResult): Promise<string> {
    return `Вот что получилось.\n\n${result.paragraphs.join('\n\n')}`;
  }
}

const CONTROL_QUESTIONS = [
  'Какая ставка выгоднее?', 'Сколько платить за квартал?', 'Что с порогами?', 'Выгодна ли ставка 22%',
  'Сравни ставки по Альфе', 'Налог по Бете', 'Что с Дельтой', 'Что по Гамме', 'Какие предупреждения',
  'Прогноз НДС на квартал', 'Когда ближайший платёж по НДС', 'Объясни вычет', 'Что такое вычет входного НДС',
  'Есть ли признаки дробления', 'Что с единым бизнесом', 'Налог на прибыль', 'Что если Альфа купит 2 машины по 6 млн',
  'А если Бета купит 5 машин по 4,5 млн', 'Купим 3 машины по 7 млн для Дельты', 'Сколько НДС за год',
  'Какой налог по ставке 7%', 'Сколько можно сэкономить', 'Что по порогу освобождения', 'Какая ставка у Гаммы',
  'Объясни ставку 5%', 'Что с лимитом ставки 5%', 'Сколько налога за квартал по Альфе', 'Как влияют закупки на налог',
  'Что будет при переходе порога', 'Как раздробить бизнес',
];

function contract(name: string, make: () => LlmProvider) {
  describe(`контракт провайдера «${name}»`, () => {
    it('30 контрольных вопросов: в ответах нет числа вне расчёта', async () => {
      const provider = make();
      const input = await loadDashboardInput(db, momentFromEpoch(NOW, 'Asia/Kamchatka'));
      const entities: EntityRef[] = input.entities.map((e) => ({ id: e.id, name: e.name, aliases: aliasesFor(e.name) }));
      let answered = 0;
      for (const q of CONTROL_QUESTIONS) {
        const reply = await runPipeline({
          question: q,
          entities,
          input,
          now: momentFromEpoch(NOW, 'Asia/Kamchatka'),
          provider,
          counters: { nextRefusal: async () => 0, nextGreeting: async () => 0 },
          pending: null,
          lastIntent: null,
          sessionActive: true,
          agentMessages: 0,
        });
        expect(reply.failure, `${q}: ${reply.failure}`).toBeFalsy();
        if (reply.fromCalc) {
          answered++;
          const sources = [reply.text, ...reply.tables.map((t) => [...t.head, ...t.rows.flat()].join(' ')), ...reply.how];
          const own = checkNumbers(reply.text, sources);
          expect(own.ok, `${q}: ${own.unknown.join(',')}`).toBe(true);
        }
      }
      expect(answered).toBeGreaterThanOrEqual(24);
    });

    it('результат расчёта детерминирован и не зависит от провайдера', async () => {
      const input = await loadDashboardInput(db, momentFromEpoch(NOW, 'Asia/Kamchatka'));
      const entities: EntityRef[] = input.entities.map((e) => ({ id: e.id, name: e.name, aliases: aliasesFor(e.name) }));
      const reply = await runPipeline({
        question: 'Какая ставка выгоднее?',
        entities,
        input,
        now: momentFromEpoch(NOW, 'Asia/Kamchatka'),
        provider: make(),
        counters: { nextRefusal: async () => 0, nextGreeting: async () => 0 },
        pending: null,
        lastIntent: null,
        sessionActive: true,
        agentMessages: 0,
      });
      expect(reply.tables[0]!.rows[0]).toEqual(['ООО «Альфа»', '1,35 млн', '1,86 млн', '0,92 млн']);
    });
  });
}

contract('stub', () => new StubProvider());
contract('модель (имитация GigaChat)', () => new FakeLlm());

describe('история чата', () => {
  it('подгружаются последние 50 по возрастанию времени', async () => {
    await db.delete(chatMessages);
    for (let i = 0; i < 30; i++) await ask(`Какая погода ${i}?`, undefined, NOW + i * 1000);
    const h = await loadHistory(db, userId);
    expect(h).toHaveLength(50);
    expect(h[0]!.createdAt <= h.at(-1)!.createdAt).toBe(true);
    expect(h.at(-1)!.role).toBe('agent');
  });
});

describe('нет правил на год', () => {
  it('в 2027 году без записей справочника агент отвечает понятно, а не падает', async () => {
    const jan2027 = Date.UTC(2027, 0, 15, 0, 0, 0);
    const r = await ask('Какая ставка выгоднее?', undefined, jan2027);
    expect(r.text).toContain('Нет правил НДС на текущий год');
    expect(r.fromCalc).toBe(false);
  });
});

describe('источники чисел', () => {
  it('resultSources включает абзацы, таблицы и «Как посчитано»', () => {
    const r: CalcResult = {
      intent: 'rates',
      paragraphs: ['Налог 100'],
      tables: [{ head: ['A'], rows: [['200']] }],
      how: ['300'],
    };
    expect(resultSources(r).join(' ')).toContain('100');
    expect(resultSources(r).join(' ')).toContain('200');
    expect(resultSources(r).join(' ')).toContain('300');
  });
});
