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
import { handleChat } from './service';
import type { ChatTurn, EntityRef } from './types';

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
    // прежний раздел: цена машины названа, пересчёт доли закупок и налога по 22%
    ['что если Альфа купит 2 машины по 6 млн', { scenario: 'cars', whatIf: null }],
    ['Что если купим машины?', { scenario: 'cars', whatIf: null }],
    // без условия «купим 3 машины по 7 млн» остаётся прежним
    ['купим 3 машины по 7 млн', { scenario: 'cars', whatIf: null }],
    // следующий год считает прогноз, а не сценарий текущего года
    ['что если на 2027 год выручка вырастет на 10%', { whatIf: null }],
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

describe('подсказка «Что если купим 5 машин?»', () => {
  it('юрлицо не названо: «Для какого юрлица?» и пять кнопок юрлиц', async () => {
    const q = await ask('Что если купим 5 машин?');
    expect(q.class).toBe('A');
    expect(q.text).toBe('Для какого юрлица?');
    expect(q.fromCalc).toBe(false);
    expect(q.quick.map((x) => x.label)).toEqual(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);
    expect(q.provenance).toBeNull();
  });

  it('по Дельте: добавочная выручка 5 × 130 000 ₽ с ноября, допущения и пометка в ответе', async () => {
    await ask('Что если купим 5 машин?');
    const r = await ask('по Дельте');
    const t = plain(r.text);
    expect(r.class).toBe('A');
    expect(r.fromCalc).toBe(true);
    expect(t.startsWith('Сценарий, а не прогноз:')).toBe(true);
    expect(t).toContain('ИП Дельта покупает 5 машин, добавочная выручка 650 000 ₽ в месяц (с ноября по декабрь 2026)');
    // допущение: выручка на машину из справочника, демо-значение
    expect(t).toContain('Допущения:');
    expect(t).toContain('выручка на машину в месяц 130 000 ₽ с НДС (демо-значение из справочника юрлица)');
    expect(t).toContain('5 × 130 000 ₽ = 650 000 ₽ в месяц, с ноября по декабрь 2026');
    // порог: Дельта пересекает его раньше, НДС с 1 января 2027 как и сейчас
    expect(t).toContain('ИП Дельта: порог 20 млн пересекается 19 декабря → 8 декабря');
    // итоговая строка и флаг единого бизнеса
    expect(t).toMatch(/По сценарию дороже на [\d ]+ ₽/);
    expect(t).toContain('Признаки единого бизнеса: один бренд, один сайт, общий парк');
    expect(r.understood).toMatchObject({ entity: 'ИП Дельта', tax: '+5 машин', kindLabel: 'сценарий' });
  });

  it('таблица «сейчас и по сценарию» и кнопки действий под ответом', async () => {
    await ask('Что если купим 5 машин?');
    const r = await ask('по Дельте');
    expect(r.tables[0]!.head).toEqual(['За год', 'Сейчас', 'По сценарию', 'Разница']);
    expect(r.tables[0]!.dense).toBe(true);
    const rows = Object.fromEntries(r.tables[0]!.rows.map((x) => [x[0], x.slice(1).map(plain)]));
    expect(rows['Выручка']).toEqual(['20,90 млн', '22,20 млн', '+1,30 млн']);
    // у Дельты порог в декабре: НДС за 2026 год остаётся нулевым
    expect(rows['НДС']).toEqual(['0 ₽', '0 ₽', '0 ₽']);
    // действия те же, что у остальных расчётов: панель, Excel, «Проверить самому», «Отправить на проверку»
    expect(r.provenance).not.toBeNull();
    expect(r.provenance!.count).toBeGreaterThanOrEqual(4);
    expect(r.provenance!.doc).toBeUndefined();
    expect(r.provenance!.line.note).toBe('сценарий, а не прогноз');
  });

  it('все числа ответа есть в расчёте: предохранитель пропускает', async () => {
    await ask('Что если купим 5 машин?');
    const r = await ask('по Дельте');
    const check = checkNumbers(r.text, [
      ...resultSources({ intent: 'whatif', paragraphs: r.text.split('\n\n'), tables: r.tables, how: r.how }),
    ]);
    expect(check.ok, check.unknown.join(', ')).toBe(true);
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
  it('«а если купим 3 машины» после ответа берёт то же юрлицо', async () => {
    await ask('Что если Бета вырастет на 10%');
    const r = await ask('а если купим 3 машины');
    expect(r.understood).toMatchObject({ entity: 'ИП Бета', tax: '+3 машины' });
    expect(plain(r.text)).toContain('добавочная выручка 450 000 ₽ в месяц');
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

  it('машины без выручки на машину в справочнике: честный отказ, а не выдуманное число', async () => {
    await db.execute(sql`update legal_entities set revenue_per_car_monthly = null where id = 'gamma'`);
    try {
      const r = await ask('что если Гамма купит 2 машины');
      expect(r.fromCalc).toBe(false);
      expect(r.text).toContain('не задана выручка на машину в месяц');
    } finally {
      await db.execute(sql`update legal_entities set revenue_per_car_monthly = 160000 where id = 'gamma'`);
    }
  });

  it('прежний сценарий покупки с ценой работает как раньше', async () => {
    const r = await ask('Что если Альфа купит 3 машины по 7 млн?');
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
    await ask('Что если купим 5 машин?');
    await ask('по Дельте');
    expect(await snapshot()).toBe(before);
  });

  it('панель, Excel и проверка получают те же расчёты: сейчас и по сценарию', async () => {
    await ask('Что если купим 5 машин?');
    const r = await ask('по Дельте');
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
    expect(plain(cmp.assumptions.join(' '))).toContain('демо-значение из справочника юрлица');

    // «по сценарию» отличается от «сейчас» только выручкой, шаги проверяются независимо
    const vatBase = snaps.find((s) => s.tax === 'vat' && s.whatIf?.role === 'base')!;
    const vatScenario = snaps.find((s) => s.tax === 'vat' && s.whatIf?.role === 'scenario')!;
    expect(Number(vatScenario.revenue)).toBeGreaterThan(Number(vatBase.revenue));
    expect(plain(vatScenario.assumptions!.join(' '))).toContain('5 × 130 000');
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

  it('запись в базе хранит понимание сценария для продолжения', async () => {
    await ask('Что если купим 5 машин?');
    const r = await ask('по Альфе');
    const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, r.id));
    const interp = (row!.calc as { interp?: { scenario?: string; whatIf?: unknown; entities?: string[] } }).interp!;
    expect(interp.scenario).toBe('whatif');
    expect(interp.whatIf).toEqual({ kind: 'cars', cars: 5 });
    expect(interp.entities).toEqual(['alfa']);
  });
});
