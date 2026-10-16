import { eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOwner } from '@/lib/auth/service';
import { computeLive, computeStatic, dashboardInput, moment, momentFromEpoch } from '@/lib/calc';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { agentState, chatMessages, users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { excelFor, resolveTarget } from '@/lib/provenance/server';
import { checkNumbers } from './text';
import { resultSources } from './answers';
import { interpret, type InterpretContext } from './interpret';
import { aliasesFor } from './pipeline';
import { handleChat, loadHistory } from './service';
import type { ChatTurn, EntityRef, FleetFormSubmit } from './types';

/** 2026-10-14 12:00 по Камчатке: до ноября один месяц, октябрь идёт */
const NOW = Date.UTC(2026, 9, 14, 0, 0, 0);
const TZ = 'Asia/Kamchatka';

let db: Db;
let close: () => Promise<void>;
let userId: string;
let clock = NOW;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db);
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
});
afterAll(async () => close());

beforeEach(async () => {
  await db.delete(chatMessages);
  await db.update(agentState).set({ refusalIndex: 0, greetIndex: 0, lastActive: null });
});

async function ask(question: string, baseId?: number): Promise<ChatTurn> {
  clock += 60_000;
  const res = await handleChat(db, { userId, question, nowMs: clock, baseId });
  return res.agent;
}

/** Кнопка «Рассчитать» в карточке: поля уходят структурой. */
async function submit(form: Partial<FleetFormSubmit>, baseId?: number): Promise<{ user: ChatTurn; agent: ChatTurn }> {
  clock += 60_000;
  return handleChat(db, { userId, question: '', nowMs: clock, baseId, form: { ...FORM, ...form } });
}

/** Поля карточки: Дельта, 5 машин по 3 млн с НДС, 8 000 ₽ в сутки × 20 дней, с ноября, расходов нет. */
const FORM: FleetFormSubmit = {
  entityId: 'delta',
  cars: 5,
  cost: 3_000_000,
  costWithVat: true,
  rentPerDay: 8_000,
  rentDays: 20,
  startMonth: 10,
  expenses: null,
};

const plain = (s: string) => s.replace(/[  ]/g, ' ');

const entities: EntityRef[] = [
  ['alfa', 'ООО «Альфа»'],
  ['beta', 'ИП Бета'],
  ['delta', 'ИП Дельта'],
  ['gamma', 'ООО «Гамма»'],
  ['epsilon', 'ООО «Эпсилон»'],
].map(([id, name]) => ({ id: id!, name: name!, aliases: aliasesFor(name!) }));

const base: InterpretContext = {
  entities,
  today: moment(2026, 10, 14, 12),
  previous: null,
  awaiting: [],
  refine: false,
  data: { from: { year: 2025, month: 1 }, to: { year: 2026, month: 12 } },
  nextYear: { year: 2027, deflatorKnown: false },
};

describe('понимание «что если»', () => {
  const table: [string, Record<string, unknown>][] = [
    ['Что если купим 5 машин?', { scenario: 'whatif', whatIf: { kind: 'cars', cars: 5 }, entities: [] }],
    ['а если купим 3 машины', { scenario: 'whatif', whatIf: { kind: 'cars', cars: 3 } }],
    ['что если Дельта купит три машины', { scenario: 'whatif', whatIf: { kind: 'cars', cars: 3 }, entities: ['delta'] }],
    ['Что если выручка вырастет на 20%?', { scenario: 'whatif', whatIf: { kind: 'growth', percent: 20 } }],
    ['а если выручка упадёт на 10%', { scenario: 'whatif', whatIf: { kind: 'growth', percent: -10 } }],
    ['а если выручка Беты вырастет на 7,5%', { scenario: 'whatif', whatIf: { kind: 'growth', percent: 7.5 }, entities: ['beta'] }],
    ['что если Дельта вырастет на 3 млн', { scenario: 'whatif', whatIf: { kind: 'amount', amount: 3_000_000 }, entities: ['delta'] }],
    ['а если у Гаммы выручка упадёт на 500 тыс', { scenario: 'whatif', whatIf: { kind: 'amount', amount: -500_000 }, entities: ['gamma'] }],
    ['что если выручка группы вырастет на 15 процентов', { scenario: 'whatif', whatIf: { kind: 'growth', percent: 15 }, mode: 'group' }],
    // цена машины названа: она подставляется в карточку как стоимость
    [
      'что если Альфа купит 2 машины по 6 млн',
      { scenario: 'whatif', entities: ['alfa'], whatIf: { kind: 'cars', cars: 2, fleet: { cost: 6_000_000 } } },
    ],
    // число машин не названо: карточка спросит и его
    ['Что если купим машины?', { scenario: 'whatif', whatIf: { kind: 'cars', cars: null } }],
    // прежний раздел: без условия «купим 3 машины по 7 млн» остаётся покупкой (доля закупок, налог по 22%)
    ['купим 3 машины по 7 млн', { scenario: 'cars', whatIf: null }],
    ['Альфа купит 2 машины по 6 млн', { scenario: 'cars', whatIf: null }],
    // следующий год считает прогноз, а не сценарий текущего года
    ['что если на 2027 год выручка вырастет на 10%', { whatIf: null }],
    // цена сдачи названа: парк машин, названные значения подставляются в карточку
    [
      'купим 3 машины по 4 млн, сдавать по 9000 в сутки',
      { scenario: 'whatif', whatIf: { kind: 'cars', cars: 3, fleet: { cost: 4_000_000, rentPerDay: 9_000 } } },
    ],
    [
      'что если Дельта купит 5 машин по 3,5 млн с НДС, сдача 8 000 ₽ в сутки, 15 дней в месяц, с декабря, расходы 20 тыс в месяц',
      {
        scenario: 'whatif',
        entities: ['delta'],
        whatIf: {
          kind: 'cars',
          cars: 5,
          fleet: { cost: 3_500_000, costWithVat: true, rentPerDay: 8_000, rentDays: 15, startMonth: 11, expensesPerMonth: 20_000 },
        },
      },
    ],
    [
      'что если купим две машины по 3 000 000 без НДС, сдавать по 7 тыс в день',
      {
        scenario: 'whatif',
        whatIf: { kind: 'cars', cars: 2, fleet: { cost: 3_000_000, costWithVat: false, rentPerDay: 7_000 } },
      },
    ],
    ['сдавать машины по 9000 в сутки', { scenario: 'whatif', whatIf: { kind: 'cars', cars: null, fleet: { rentPerDay: 9_000 } } }],
  ];
  for (const [text, want] of table) {
    it(`«${text}»`, () => {
      const i = interpret(text, base);
      if ('scenario' in want) expect(i.scenario, 'сценарий').toBe(want.scenario);
      if ('whatIf' in want) expect(i.whatIf ?? null, 'что меняется').toEqual(want.whatIf);
      if ('entities' in want) expect(i.entities, 'юрлица').toEqual(want.entities);
      if ('mode' in want) expect(i.entityMode, 'охват').toBe(want.mode);
    });
  }

  it('«а если рост 20%?» после прогноза на 2027 год продолжает прогноз, «Что если …» это новый сценарий', () => {
    const forecast = interpret('какую ставку выбрать на 2027 год', base);
    const cont = interpret('а если рост 20%?', { ...base, previous: forecast });
    expect(cont.forecast).toEqual({ year: 2027, growth: 20 });
    expect(cont.whatIf ?? null).toBeNull();
    const fresh = interpret('Что если выручка вырастет на 20%?', { ...base, previous: forecast });
    expect(fresh.whatIf).toEqual({ kind: 'growth', percent: 20 });
    expect(fresh.forecast ?? null).toBeNull();
    // и сам вопрос про 2027 год с ростом остаётся прогнозом
    expect(interpret('что если на 2027 год выручка вырастет на 10%', base).forecast).toEqual({ year: 2027, growth: 10 });
  });

  it('ответ «по Дельте» на вопрос «Для какого юрлица?» продолжает сценарий', () => {
    const asked = interpret('Что если купим 5 машин?', base);
    const i = interpret('по Дельте', { ...base, previous: asked, awaiting: ['entity'] });
    expect(i.scenario).toBe('whatif');
    expect(i.whatIf).toEqual({ kind: 'cars', cars: 5 });
    expect(i.entities).toEqual(['delta']);
  });
});

describe('подсказка «Что если купим 5 машин?»: карточка с полями', () => {
  it('открывает карточку, а не считает: юрлицо, стоимость и цена сдачи не названы', async () => {
    const q = await ask('Что если купим 5 машин?');
    expect(q.class).toBe('A');
    expect(q.fromCalc).toBe(false);
    expect(q.provenance).toBeNull();
    expect(q.tables).toEqual([]);
    expect(q.quick).toEqual([]);
    expect(q.text).toBe('Чтобы посчитать, уточните параметры машин. Не хватает: юрлицо, стоимость машины, цена сдачи.');
    const f = q.form!;
    expect(f.mode).toBe('ask');
    expect(f.missing).toEqual(['entity', 'cost', 'rent']);
    expect(f.confirmVat).toBe(false);
    // названное подставлено, ненайденное пусто, два значения по умолчанию видны в полях
    expect(f.values).toEqual({
      entityId: null,
      cars: 5,
      cost: null,
      costWithVat: true,
      rentPerDay: null,
      rentDays: 20,
      startMonth: 10,
      expenses: null,
    });
    expect(f.entities.map((e) => e.label)).toEqual(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);
    // со следующего месяца до декабря
    expect(f.months).toEqual([
      { value: 10, label: 'Ноябрь' },
      { value: 11, label: 'Декабрь' },
    ]);
    // быстрые варианты: значения не названы
    expect(f.quick).toEqual({ cost: [2_000_000, 3_000_000, 5_000_000], rent: [5_000, 8_000, 12_000] });
  });

  it('карточка хранится в базе и приходит в истории', async () => {
    const q = await ask('Что если купим 5 машин?');
    const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, q.id));
    expect((row!.calc as { form?: { mode?: string } }).form?.mode).toBe('ask');
    const history = await loadHistory(db, userId);
    expect(history.at(-1)!.form?.values.cars).toBe(5);
  });

  it('«Рассчитать»: добавочная выручка 5 × 160 000 ₽ с ноября, принятые значения вверху, пометка в ответе', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { user, agent: r } = await submit({}, q.id);
    // в ленте остаётся читаемая строка о том, что посчитано
    expect(plain(user.text)).toBe(
      'Посчитать: ИП Дельта, 5 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября',
    );
    const t = plain(r.text);
    expect(r.class).toBe('A');
    expect(r.fromCalc).toBe(true);
    // вверху: пометка и принятые значения одной строкой
    expect(t.startsWith(
      'Сценарий, а не прогноз: 5 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября.',
    )).toBe(true);
    expect(t).toContain('ИП Дельта покупает 5 машин, добавочная выручка 800 000 ₽ в месяц (с ноября по декабрь 2026)');
    // выручка, НДС, налог по режиму, итог
    expect(t).toContain('Новый прогноз года: выручка 22,50 млн (было 20,90 млн, +1,60 млн)');
    expect(t).toContain('НДС за год:');
    expect(t).toContain('Налог по УСН за год:');
    expect(t).toMatch(/По сценарию дороже на [\d ]+ ₽/);
    // порог освобождения у Дельты
    expect(t).toMatch(/ИП Дельта: порог 20 млн пересекается 19 декабря → \d+ (?:ноября|декабря), НДС начнётся с 1 (?:декабря|января 2027)/);
    // вычета у освобождённого нет, об этом сказано явно
    expect(t).toContain('Вычета входного НДС по машинам нет: у ИП Дельта освобождение от НДС');
    // окупаемость по ручной формуле: 3 000 000 / 160 000 = 18,75
    expect(t).toContain('Окупаемость: 3 000 000 ₽ / 160 000 ₽ = 18,8 мес.');
    expect(t).toContain('Признаки единого бизнеса: один бренд, один сайт, общий парк');
    expect(t).toContain('Допущения:');
    expect(t).not.toContain('демо-значение');
    expect(r.understood).toMatchObject({ entity: 'ИП Дельта', tax: '+5 машин', kindLabel: 'сценарий' });
  });

  it('под ответом «Изменить» открывает те же поля с введёнными значениями', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({ cost: 4_500_000, costWithVat: false, expenses: 25_000 }, q.id);
    const f = r.form!;
    expect(f.mode).toBe('edit');
    expect(f.missing).toEqual([]);
    expect(f.values).toEqual({
      entityId: 'delta',
      cars: 5,
      cost: 4_500_000,
      costWithVat: false,
      rentPerDay: 8_000,
      rentDays: 20,
      startMonth: 10,
      expenses: 25_000,
    });
    expect(r.change).toBeNull();
  });

  it('правка полей пересчитывает сценарий и не плодит карточек с чужими значениями', async () => {
    const q = await ask('Что если купим 5 машин?');
    const first = await submit({}, q.id);
    const second = await submit({ rentPerDay: 12_000, startMonth: 11 }, first.agent.id);
    const t = plain(second.agent.text);
    expect(t).toContain('сдача 12 000 ₽ в сутки × 20 дней = 240 000 ₽ в месяц на машину, с декабря');
    expect(t).toContain('добавочная выручка 1 200 000 ₽ в месяц (декабрь 2026)');
  });

  it('все числа ответа есть в расчёте: предохранитель пропускает', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({ expenses: 20_000 }, q.id);
    const check = checkNumbers(r.text, [
      ...resultSources({ intent: 'whatif', paragraphs: r.text.split('\n\n'), tables: r.tables, how: r.how }),
    ]);
    expect(check.ok, check.unknown.join(', ')).toBe(true);
  });

  it('таблица «сейчас и по сценарию» и кнопки действий под ответом', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({}, q.id);
    expect(r.tables[0]!.head).toEqual(['За год', 'Сейчас', 'По сценарию', 'Разница']);
    expect(r.tables[0]!.dense).toBe(true);
    const rows = Object.fromEntries(r.tables[0]!.rows.map((x) => [x[0], x.slice(1).map(plain)]));
    expect(rows['Выручка']).toEqual(['20,90 млн', '22,50 млн', '+1,60 млн']);
    // у Дельты порог в декабре: НДС за 2026 год остаётся нулевым
    expect(rows['НДС']).toEqual(['0 ₽', '0 ₽', '0 ₽']);
    // действия те же, что у остальных расчётов: панель, Excel, «Проверить самому», «Отправить на проверку»
    expect(r.provenance).not.toBeNull();
    expect(r.provenance!.count).toBeGreaterThanOrEqual(4);
    expect(r.provenance!.doc).toBeUndefined();
    expect(r.provenance!.line.note).toBe('сценарий, а не прогноз');
  });
});

describe('значения из вопроса подставляются, спрашивается только недостающее', () => {
  it('«купим 3 машины по 4 млн, сдавать по 9000 в сутки»: стоимость и сдача названы, юрлицо нет', async () => {
    const q = await ask('купим 3 машины по 4 млн, сдавать по 9000 в сутки');
    expect(q.fromCalc).toBe(false);
    expect(q.provenance).toBeNull();
    const f = q.form!;
    expect(f.missing).toEqual(['entity']);
    expect(f.values).toMatchObject({ entityId: null, cars: 3, cost: 4_000_000, rentPerDay: 9_000, rentDays: 20, startMonth: 10 });
    // «с НДС или без» не названо: переключатель просит подтвердить
    expect(f.confirmVat).toBe(true);
    expect(q.text).toBe('Чтобы посчитать, уточните параметры машин. Не хватает: юрлицо.');
  });

  it('всё названо, включая «с НДС»: считает сразу, без карточки с вопросом', async () => {
    const r = await ask('что если Дельта купит 3 машины по 4 млн с НДС, сдавать по 9000 в сутки');
    const t = plain(r.text);
    expect(r.fromCalc).toBe(true);
    expect(r.form!.mode).toBe('edit');
    expect(t).toContain(
      'Сценарий, а не прогноз: 3 машины по 4 000 000 ₽ с НДС, сдача 9 000 ₽ в сутки × 20 дней = 180 000 ₽ в месяц на машину, с ноября.',
    );
  });

  it('стоимость без «с НДС» или «без НДС»: считать нельзя, пока человек не подтвердит', async () => {
    const q = await ask('что если Дельта купит 3 машины по 4 млн, сдавать по 9000 в сутки');
    expect(q.fromCalc).toBe(false);
    expect(q.form!.mode).toBe('ask');
    expect(q.form!.missing).toEqual([]);
    expect(q.form!.confirmVat).toBe(true);
    expect(q.text).toContain('с НДС или без НДС');
  });

  it('месяц начала уже идёт: молча не заменяется, карточка просит проверить', async () => {
    const r = await ask('что если Дельта купит 3 машины по 4 млн с НДС, сдавать по 9000 в сутки с октября');
    expect(r.fromCalc).toBe(false);
    expect(r.form!.values.startMonth).toBe(10);
    expect(r.form!.note).toContain('не раньше следующего месяца');
    // а названный будущий месяц принимается
    const ok = await ask('что если Дельта купит 3 машины по 4 млн с НДС, сдавать по 9000 в сутки с декабря');
    expect(ok.fromCalc).toBe(true);
    expect(plain(ok.text)).toContain('= 180 000 ₽ в месяц на машину, с декабря.');
  });

  it('без цены сдачи ничего не считается, пока поле пусто', async () => {
    const q = await ask('что если Дельта купит 5 машин');
    expect(q.fromCalc).toBe(false);
    expect(q.form!.missing).toEqual(['cost', 'rent']);
    // юрлицо «по Дельте» текстом тоже продолжает карточку
    const q2 = await ask('по Дельте');
    expect(q2.form!.values.entityId).toBe('delta');
    expect(q2.form!.values.cars).toBe(5);
    expect(q2.fromCalc).toBe(false);
  });

  it('число машин не названо: карточка спрашивает и его', async () => {
    const q = await ask('сдавать машины по 9000 в сутки');
    expect(q.form!.missing).toEqual(['entity', 'cars', 'cost']);
    expect(q.form!.values.rentPerDay).toBe(9_000);
    expect(q.fromCalc).toBe(false);
  });

  it('карточка с неверным значением не считает и возвращается с пояснением и введёнными полями', async () => {
    const q = await ask('Что если купим 5 машин?');
    // сдача не может начаться в идущем месяце (октябрь)
    const { agent: r } = await submit({ startMonth: 9, rentPerDay: 11_000 }, q.id);
    expect(r.fromCalc).toBe(false);
    expect(r.provenance).toBeNull();
    expect(r.form!.mode).toBe('ask');
    expect(r.form!.note).toContain('не раньше следующего месяца');
    expect(r.form!.values.rentPerDay).toBe(11_000);
  });

  it('неизвестное юрлицо в карточке не считается', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({ entityId: 'omega' }, q.id);
    expect(r.fromCalc).toBe(false);
    expect(r.form!.missing).toContain('entity');
  });

  it('в декабре месяцев не остаётся: карточка не нужна, расчёт не меняется', async () => {
    clock = Date.UTC(2026, 11, 10, 0, 0, 0);
    try {
      const r = await ask('Что если купим 5 машин?');
      expect(r.form).toBeNull();
      expect(r.fromCalc).toBe(false);
      expect(r.text).toContain('месяцев, в которых машины дали бы выручку, не осталось: расчёт не меняется');
    } finally {
      clock = NOW;
    }
  });
});

describe('входной НДС по машинам в ответе', () => {
  async function answerFor(entity: string, over: Partial<FleetFormSubmit> = {}): Promise<string> {
    const q = await ask('Что если купим 5 машин?');
    const { agent } = await submit({ entityId: entity, ...over }, q.id);
    return plain(agent.text);
  }

  it('Эпсилон на 22% с вычетами: вычет назван, НДС уменьшается', async () => {
    const t = await answerFor('epsilon');
    expect(t).toContain('Входной НДС по машинам 2 704 918 ₽ (5 × 3 000 000 ₽ × 22 / 122) принят к вычету в ноябре');
    expect(t).toContain('ООО «Эпсилон» ставка 22% с вычетами');
    // Эпсилон на ОСНО: стоимость машин в расходы не включена, нужен бухгалтер
    expect(t).toContain('этот эффект не учтён, нужен бухгалтер');
    expect(t).toMatch(/НДС за год: 6[,.]00 млн → 3[,.]\d\d млн/);
  });

  it('Альфа на 5%: вычета нет, сказано явно', async () => {
    const t = await answerFor('alfa');
    expect(t).toContain('Вычета входного НДС по машинам нет: у ООО «Альфа» выбрана ставка 5%, при ней вычеты не применяются');
    // УСН «доходы»: стоимость машины на налог не влияет, предупреждения о бухгалтере нет
    expect(t).not.toContain('нужен бухгалтер');
  });

  it('Бета: расходы на машину уменьшают базу, стоимость в расходы не включена', async () => {
    const t = await answerFor('beta', { expenses: 20_000 });
    expect(t).toContain('Расходы на машины 5 × 20 000 ₽ × 2 месяца = 200 000 ₽ добавлены к расходам юрлица (УСН доходы минус расходы)');
    expect(t).toContain('этот эффект не учтён, нужен бухгалтер');
    expect(t).toContain('Окупаемость: 3 000 000 ₽ / (160 000 ₽ − 20 000 ₽) = 3 000 000 ₽ / 140 000 ₽ = 21,4 мес.');
  });
});

describe('подсказка «Что если выручка вырастет на 20%?»', () => {
  it('юрлицо не названо: тот же вопрос с кнопками юрлиц, по группе пересчитывает всех', async () => {
    const q = await ask('Что если выручка вырастет на 20%?');
    expect(q.text).toBe('Для какого юрлица?');
    expect(q.quick.map((x) => x.label)).toEqual(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);

    const r = await ask('по группе');
    const t = plain(r.text);
    expect(t).toContain('Сценарий, а не прогноз:');
    expect(t).toContain('выручка прогнозных месяцев (с октября по декабрь 2026) вырастет на 20%');
    expect(r.understood).toMatchObject({ entity: 'Вся группа', tax: '+20% к выручке' });
    // по юрлицам таблица налогов, итог по группе
    expect(r.tables).toHaveLength(2);
    expect(r.tables[1]!.head).toEqual(['Налоги', 'Сейчас', 'По сценарию', 'Разница']);
    expect(r.tables[1]!.rows).toHaveLength(6);
  });

  it('«сейчас» совпадает с цифрами дашборда на ту же дату', async () => {
    await ask('Что если выручка вырастет на 20%?');
    const r = await ask('по группе');
    const data = await loadCalcData(db, momentFromEpoch(clock, TZ));
    const input = dashboardInput(data);
    const at = momentFromEpoch(clock, TZ);
    const stat = computeStatic(input, at);
    computeLive(input, at, stat);
    const rows = Object.fromEntries(r.tables[0]!.rows.map((x) => [x[0], x.slice(1).map(plain)]));
    // НДС года и налог на прибыль с УСН в «сейчас» это блоки дашборда: 8,40 млн, 4,16 + 3,89 млн
    expect(rows['НДС']![0]).toBe('8,40 млн');
    expect(rows['Налог на прибыль и УСН']![0]).toBe('8,05 млн');
  });

  it('по юрлицу: Эпсилон считает налог на прибыль, а не УСН', async () => {
    const r = await ask('Что если Эпсилон вырастет на 20%');
    expect(plain(r.text)).toContain('Налог на прибыль за год: 4,16 млн → 4,83 млн');
    expect(r.text).not.toContain('Налог по УСН');
  });
});

describe('свободный ввод', () => {
  it('«а если купим 3 машины» после рост-сценария берёт то же юрлицо, но стоимость и сдачу спрашивает', async () => {
    await ask('Что если Бета вырастет на 10%');
    const r = await ask('а если купим 3 машины');
    expect(r.fromCalc).toBe(false);
    expect(r.form!.values).toMatchObject({ entityId: 'beta', cars: 3, cost: null, rentPerDay: null });
    expect(r.form!.missing).toEqual(['cost', 'rent']);
  });

  it('«а если купим 10 машин» после ответа берёт цену, сдачу и юрлицо из прежнего расчёта', async () => {
    const q = await ask('Что если купим 5 машин?');
    const first = await submit({ entityId: 'beta', expenses: 20_000 }, q.id);
    const r = await ask('а если купим 10 машин', first.agent.id);
    const t = plain(r.text);
    expect(r.understood).toMatchObject({ entity: 'ИП Бета', tax: '+10 машин' });
    expect(t).toContain('10 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября');
    expect(t).toContain('добавочная выручка 1 600 000 ₽ в месяц');
  });

  it('«а если выручка упадёт на 10%» даёт «выгоднее»', async () => {
    const r = await ask('а если выручка упадёт на 10% у Альфы');
    expect(plain(r.text)).toMatch(/По сценарию выгоднее на [\d ]+ ₽/);
    expect(r.understood).toMatchObject({ entity: 'ООО «Альфа»', tax: '−10% к выручке' });
  });

  it('«что если Дельта вырастет на 3 млн»: порог пересекается в ноябре, НДС с 1 декабря', async () => {
    const r = await ask('что если Дельта вырастет на 3 млн');
    const t = plain(r.text);
    expect(t).toContain('порог 20 млн пересекается 19 декабря → 29 ноября, НДС начнётся с 1 декабря вместо 1 января 2027');
    expect(t).toContain('НДС за год: 0 ₽ →');
  });

  it('выручка на машину из справочника юрлица в расчёт не попадает', async () => {
    await db.execute(sql`update legal_entities set revenue_per_car_monthly = null where id = 'gamma'`);
    try {
      // пусто в справочнике: раньше сценарий отказывал, теперь цену сдачи называет человек
      const q = await ask('Что если купим 2 машины?');
      const { agent: r } = await submit({ entityId: 'gamma', cars: 2 }, q.id);
      expect(r.fromCalc).toBe(true);
      expect(plain(r.text)).toContain('добавочная выручка 320 000 ₽ в месяц');
    } finally {
      await db.execute(sql`update legal_entities set revenue_per_car_monthly = 160000 where id = 'gamma'`);
    }
  });

  it('«что если Альфа купит 3 машины по 7 млн?»: цена покупки подставлена в карточку, цену сдачи спрашивает', async () => {
    const r = await ask('Что если Альфа купит 3 машины по 7 млн?');
    expect(r.fromCalc).toBe(false);
    expect(r.form!.values).toMatchObject({ entityId: 'alfa', cars: 3, cost: 7_000_000, rentPerDay: null });
    expect(r.form!.missing).toEqual(['rent']);
    // с НДС или без не названо: просит подтвердить
    expect(r.form!.confirmVat).toBe(true);
  });

  it('прежний сценарий покупки (без условия и без сдачи) работает как раньше', async () => {
    const r = await ask('Купим 3 машины по 7 млн для Альфы');
    expect(plain(r.text)).toContain('ООО «Альфа» покупает 3 машины по 7 млн ₽ с НДС, всего 21,0 млн');
    expect(r.text).not.toContain('Сценарий, а не прогноз');
  });
});

describe('сценарий не меняет данные и действия работают по сохранённому ответу', () => {
  it('цифры дашборда до и после сценария те же', async () => {
    const at = momentFromEpoch(NOW, TZ);
    const snapshot = async () => {
      const data = await loadCalcData(db, at);
      const input = dashboardInput(data);
      const stat = computeStatic(input, at);
      const live = computeLive(input, at, stat);
      return JSON.stringify({
        ytd: live.ytdGroup.toString(),
        vat: live.taxAccruedGroup.toString(),
        forecast: stat.forecastGroup.toString(),
        profit: stat.incomeTaxGroup.profit.toString(),
        usn: stat.incomeTaxGroup.usn.toString(),
        entities: data.entities.map((e) => [e.id, e.annualRevenue.toString()]),
      });
    };
    const before = await snapshot();
    await ask('Что если выручка вырастет на 20%?');
    await ask('по группе');
    const q = await ask('Что если купим 5 машин?');
    await submit({ expenses: 20_000 }, q.id);
    await submit({ entityId: 'epsilon', cost: 9_000_000 }, q.id);
    expect(await snapshot()).toBe(before);
  });

  it('панель, Excel и проверка получают те же расчёты: сейчас и по сценарию', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({}, q.id);
    const snaps = await resolveTarget(db, {
      userId,
      target: { message: r.id },
      nowMs: clock,
      tz: TZ,
    });
    expect(snaps.length).toBeGreaterThanOrEqual(4);
    expect(snaps.filter((s) => s.whatIf?.role === 'scenario').length).toBe(snaps.length / 2);
    expect(snaps.filter((s) => s.whatIf?.role === 'base').length).toBe(snaps.length / 2);
    // сравнение хранится один раз
    expect(snaps.filter((s) => s.comparison).length).toBe(1);
    const cmp = snaps.find((s) => s.comparison)!.comparison!;
    expect(cmp.kind).toBe('cars');
    expect(plain(cmp.assumptions.join(' '))).toContain('цена сдачи 8 000 ₽ в сутки × 20 дней');

    // «по сценарию» отличается от «сейчас» только выручкой, шаги проверяются независимо
    const vatBase = snaps.find((s) => s.tax === 'vat' && s.whatIf?.role === 'base')!;
    const vatScenario = snaps.find((s) => s.tax === 'vat' && s.whatIf?.role === 'scenario')!;
    expect(Number(vatScenario.revenue)).toBeGreaterThan(Number(vatBase.revenue));
    expect(plain(vatScenario.assumptions!.join(' '))).toContain('5 × 160 000');
    expect(vatBase.assumptions).toEqual([]);

    // Excel: первый лист «Сценарий» с разницей формулой
    const file = await excelFor(snaps);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.file as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.name).toBe('Сценарий');
    const ws = wb.worksheets[0]!;
    let found = false;
    ws.eachRow((row) => {
      if (row.getCell(1).value === 'Выручка за год') {
        found = true;
        const diff = row.getCell(4).value as { formula: string };
        expect(diff.formula).toMatch(/^C\d+-B\d+$/);
      }
    });
    expect(found).toBe(true);
    for (const name of ['Итог', 'По месяцам', 'Расчёт', 'Источник']) {
      expect(wb.getWorksheet(name), name).toBeTruthy();
    }
  });

  it('запись в базе хранит понимание сценария со всеми значениями для продолжения', async () => {
    const q = await ask('Что если купим 5 машин?');
    const { agent: r } = await submit({ entityId: 'alfa' }, q.id);
    const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, r.id));
    const interp = (row!.calc as { interp?: { scenario?: string; whatIf?: unknown; entities?: string[] } }).interp!;
    expect(interp.scenario).toBe('whatif');
    expect(interp.whatIf).toEqual({
      kind: 'cars',
      cars: 5,
      fleet: { cost: 3_000_000, costWithVat: true, rentPerDay: 8_000, rentDays: 20, startMonth: 10, expensesPerMonth: 0 },
    });
    expect(interp.entities).toEqual(['alfa']);
  });
});
