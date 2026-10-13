import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Маршруты проверяются целиком на настоящей базе (PGlite): подменены только вход и выдача ответа.
const h = vi.hoisted(() => ({ db: null as unknown, user: '' }));
vi.mock('@/lib/db/client', () => ({ getDb: () => h.db, closeDb: async () => undefined }));
vi.mock('@/lib/auth/server', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireApiAuth: async () => ({ ok: true, auth: { userId: h.user } }),
    json: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    failure: (_scope: string, e: unknown) => {
      throw e;
    },
  };
});

import { GET as checksGet, POST as checksPost } from '@/app/api/checks/route';
import { POST as calcPost } from '@/app/api/calc/route';
import { GET as exportGet } from '@/app/api/export/route';
import { GET as reviewsGet, POST as reviewsPost } from '@/app/api/reviews/route';
import { createOwner } from '@/lib/auth/service';
import { calcTax, verifyCalcResult } from '@/lib/calc/service';
import { momentFromEpoch } from '@/lib/calc/time';
import { handleChat, loadHistory } from '@/lib/agent/service';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { checks, chatMessages, people, reviewRequests, users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { buildDashboardProvenance, bannerQueries, entityQueries } from './dashboard';
import { buildChecklist, formulasText } from './checklist';
import { KIND_LABEL, lineFromSnapshots, shortDateTime, shortSource, sourceLineText, stampShort } from './line';
import { exportFileName, requestTitle, subjectOf, type CalcQuery } from './query';
import { runQueries } from './schemas';
import { fromSnapshot, toSnapshot } from './snapshot';
import { normLink, NK_PART_2_URL } from './norms';

const TZ = 'Asia/Kamchatka';
/** 2026-10-10 12:00 по Камчатке: так же, как в CALC.md и в тестах чата */
const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  await seedDatabase(db, { tz: TZ });
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
  h.user = userId;
});
afterAll(async () => close());

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Часы замораживаются на контрольный момент, как у /api/dashboard в consistency.test.ts. */
async function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

const feb: CalcQuery = { tax: 'vat', period: { kind: 'month', year: 2026, month: 2 }, entityIds: ['alfa'] };
const ytd: CalcQuery = { tax: 'vat', period: { kind: 'ytd' }, entityIds: 'all' };

async function data() {
  return loadCalcData(db, momentFromEpoch(NOW, TZ));
}

describe('снимок расчёта', () => {
  it('туда и обратно без потерь: те же суммы, шаги проходят проверку происхождения', async () => {
    const d = await data();
    for (const q of [feb, ytd, { tax: 'usn', period: { kind: 'year', year: 2026 }, entityIds: 'all' } as CalcQuery]) {
      const r = calcTax({ entityIds: q.entityIds, tax: q.tax, period: q.period }, d);
      const snap = JSON.parse(JSON.stringify(toSnapshot(r, { at: NOW, tz: TZ, scope: q.entityIds })));
      const back = fromSnapshot(snap);
      expect(back.total?.toString()).toBe(r.total?.toString());
      expect(back.revenue?.toString()).toBe(r.revenue?.toString());
      expect(back.steps.map((s) => s.result.toString())).toEqual(r.steps.map((s) => s.result.toString()));
      expect(verifyCalcResult(back)).toEqual([]);
    }
  });
});

describe('строка происхождения', () => {
  it('формат: источник · обновлено · основа; юрлицо и период только по запросу', async () => {
    const [snap] = runQueries(await data(), [feb], { at: NOW, tz: TZ });
    const line = lineFromSnapshots([snap!]);
    expect(sourceLineText(line)).toBe('Выгрузка из 1С · обновлено 10.10, 18:00 · факт');
    expect(sourceLineText(line, { scope: true, period: true })).toBe(
      'Выгрузка из 1С · ООО «Альфа» · февраль 2026 · обновлено 10.10, 18:00 · факт',
    );
    // метки «Демо-данные» в строке нет: она один раз в шапке приложения
    expect(sourceLineText(line)).not.toContain('Демо-данные');
    expect(line.isDemo).toBe(true);
    // полная отметка времени остаётся в данных строки
    expect(line.updated).toBe('10.10.2026 18:00');
  });

  it('год обновления показывается, только если отличается от года расчёта', () => {
    const at = Date.UTC(2025, 11, 31, 6, 0, 0);
    expect(stampShort(at, TZ, 2025)).toBe('31.12, 18:00');
    expect(stampShort(at, TZ, 2026)).toBe('31.12.2025, 18:00');
    expect(shortSource('Выгрузка из 1С (демо)')).toBe('Выгрузка из 1С');
    expect(shortSource('Ручной ввод')).toBe('Ручной ввод');
  });

  it('метка основы: факт, прогноз, факт и прогноз', async () => {
    const d = await data();
    const kinds = runQueries(
      d,
      [
        feb,
        { tax: 'vat', period: { kind: 'month', year: 2026, month: 12 }, entityIds: ['alfa'] },
        ytd,
        { tax: 'vat', period: { kind: 'year', year: 2026 }, entityIds: 'all' },
      ],
      { at: NOW, tz: TZ },
    ).map((s) => KIND_LABEL[lineFromSnapshots([s]).kind]);
    expect(kinds).toEqual(['факт', 'прогноз', 'факт и прогноз', 'факт и прогноз']);
  });

  it('юрлица: вся группа, семейство режима, ОСНО', async () => {
    const d = await data();
    const [vat, usn, profit] = runQueries(
      d,
      [
        ytd,
        { tax: 'usn', period: { kind: 'year', year: 2026 }, entityIds: 'all' },
        { tax: 'profit', period: { kind: 'year', year: 2026 }, entityIds: 'all' },
      ],
      { at: NOW, tz: TZ },
    );
    expect(lineFromSnapshots([vat!]).scope).toBe('Вся группа');
    expect(lineFromSnapshots([usn!]).scope).toBe('Юрлица на УСН');
    expect(lineFromSnapshots([profit!]).scope).toBe('ООО «Эпсилон»');
    // налог на прибыль и УСН вместе покрывают группу
    expect(lineFromSnapshots([profit!, usn!]).scope).toBe('Вся группа');
  });

  it('время в поясе приложения', () => {
    expect(shortDateTime(Date.UTC(2026, 9, 10, 6, 0, 0), 'Asia/Kamchatka')).toBe('10.10.2026 18:00');
    expect(shortDateTime(Date.UTC(2026, 9, 10, 6, 0, 0), 'UTC')).toBe('10.10.2026 06:00');
  });

  it('данные дашборда: у каждого баннера и блока карточки своя строка из calcTax', async () => {
    const d = await data();
    const p = buildDashboardProvenance(d, TZ, NOW);
    expect(Object.keys(p.banners).sort()).toEqual(['profit', 'revenue', 'vat', 'vatForecast']);
    expect(p.year).toBe(2026);
    for (const l of Object.values(p.banners)) {
      expect(l.source).toBe('Выгрузка из 1С');
      expect(l.updated).toBe('10.10.2026 18:00');
    }
    expect(p.banners.revenue.period).toBe('с начала года');
    expect(p.banners.vatForecast.period).toBe('2026 год');
    expect(p.banners.revenue.kind).toBe('mixed');
    expect(Object.keys(p.entities).sort()).toEqual(['alfa', 'beta', 'delta', 'epsilon', 'gamma']);
    expect(p.entities.alfa!.metrics.scope).toBe('ООО «Альфа»');
    expect(p.entities.alfa!.metrics.period).toBe('с начала года, прогноз на 2026 год');
    // освобождённые юрлица: цифры ставок условные; об этом сказано один раз над карточками ставок,
    // в строке происхождения пометки нет
    expect(p.entities.delta!.conditional).toBe(true);
    expect(p.entities.delta!.vat.note).toBeUndefined();
    expect(p.entities.alfa!.conditional).toBe(false);
    expect(p.entities.alfa!.vat.note).toBeUndefined();
  });

  it('запросы дашборда: баннеры и карточка юрлица', () => {
    expect(bannerQueries('revenue', 2026)).toEqual([{ tax: 'vat', period: { kind: 'ytd' }, entityIds: 'all' }]);
    expect(bannerQueries('profit', 2026).map((q) => q.tax)).toEqual(['profit', 'usn']);
    const q = entityQueries({ id: 'alfa', taxRegime: 'usn_income', selected: 7 }, 2026);
    expect(q.map((x) => `${x.tax}:${x.period.kind}`)).toEqual(['vat:ytd', 'vat:year', 'usn:ytd', 'usn:year']);
    expect(q.every((x) => x.rate === 7 && Array.isArray(x.entityIds))).toBe(true);
    // на ОСНО ставка не передаётся: она одна
    const osno = entityQueries({ id: 'epsilon', taxRegime: 'osno', selected: 22 }, 2026);
    expect(osno.every((x) => x.rate === undefined)).toBe(true);
    expect(osno[2]!.tax).toBe('profit');
  });
});

describe('имя файла, заголовок, ключ расчёта, нормы', () => {
  it('имя «НДС_Альфа_2026-02.xlsx» и заголовок запроса', async () => {
    const d = await data();
    const snaps = runQueries(d, [feb], { at: NOW, tz: TZ });
    expect(exportFileName(snaps)).toBe('НДС_Альфа_2026-02.xlsx');
    expect(requestTitle(snaps)).toBe('НДС, ООО «Альфа», февраль 2026');
    const pair = runQueries(
      d,
      entityQueries({ id: 'alfa', taxRegime: 'usn_income', selected: 5 }, 2026),
      { at: NOW, tz: TZ },
    );
    expect(requestTitle(pair)).toBe('НДС и налог по УСН, ООО «Альфа», с начала года, прогноз на 2026 год');
  });

  it('ключ расчёта не зависит от момента, но зависит от ставки и юрлиц', async () => {
    const d = await data();
    const a = runQueries(d, [ytd], { at: NOW, tz: TZ });
    const b = runQueries(d, [ytd], { at: NOW + 3_600_000, tz: TZ });
    expect(subjectOf(a)).toBe(subjectOf(b));
    const r = runQueries(d, [{ ...ytd, rate: 7 }], { at: NOW, tz: TZ });
    expect(subjectOf(r)).not.toBe(subjectOf(a));
    expect(subjectOf(runQueries(d, [feb], { at: NOW, tz: TZ }))).toBe('vat:m2026-02:alfa:5');
  });

  it('норма ведёт на вторую часть НК РФ, собственный адрес правила важнее', () => {
    expect(normLink('НК РФ, ст. 164', null)).toEqual({ text: 'НК РФ, ст. 164', url: NK_PART_2_URL });
    expect(normLink('НК РФ, ст. 164', 'https://example.org/n')?.url).toBe('https://example.org/n');
    expect(normLink('НК РФ, ст. 164', 'javascript:alert(1)')?.url).toBe(NK_PART_2_URL);
    expect(normLink(null, null)).toBeNull();
  });
});

describe('чек-лист «Проверить самому»', () => {
  it('исходные цифры, правила с нормой, шаги по юрлицам и итог', async () => {
    const snaps = runQueries(await data(), [ytd], { at: NOW, tz: TZ });
    const [s] = buildChecklist(snaps);
    expect(s!.items.map((i) => i.id)).toEqual([
      'src',
      'rules',
      'ent:alfa',
      'ent:beta',
      'ent:delta',
      'ent:gamma',
      'ent:epsilon',
      'total',
    ]);
    expect(s!.words.length).toBeGreaterThan(2);
    expect(s!.rules.some((r) => r.norm?.text === 'НК РФ, ст. 164' && r.norm.url === NK_PART_2_URL)).toBe(true);
    expect(s!.entities.every((e) => e.steps.length > 0)).toBe(true);
    expect(s!.amount).toBe(snaps[0]!.total);
  });

  it('текст формул: шаги с выражениями и итог', async () => {
    const snaps = runQueries(await data(), [feb], { at: NOW, tz: TZ });
    const text = formulasText(snaps);
    expect(text).toContain('Шаг\tЮрлицо\tФормула\tРезультат, ₽\tКак считается');
    expect(text).toContain('s1\tООО «Альфа»\t1988000');
    expect(text).toContain('s2\tООО «Альфа»\ts1 * 5 / 105\t94666.67');
    expect(text.toLowerCase()).not.toContain('демо');
  });
});

describe('API: расчёт, выгрузка, передача, отметки', () => {
  it('/api/calc: те же числа, что у calcTax, и снимок со всеми полями', async () => {
    const res = await atNow(() => calcPost(post('/api/calc', { queries: [feb, ytd], at: NOW })));
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: ReturnType<typeof toSnapshot>[] };
    expect(items).toHaveLength(2);
    const d = await data();
    const expected = calcTax({ entityIds: ['alfa'], tax: 'vat', period: feb.period }, d);
    expect(items[0]!.total).toBe(expected.total!.toString());
    expect(items[0]!.source).toMatchObject({ id: 'demo-1c', isDemo: true });
    expect(items[0]!.at).toBe(NOW);
    expect(items[1]!.period).toEqual({ kind: 'ytd' });
  });

  it('/api/calc: неизвестное юрлицо и некорректный запрос', async () => {
    const bad = await calcPost(post('/api/calc', { queries: [{ ...feb, entityIds: ['nobody'] }] }));
    expect(bad.status).toBe(422);
    const wrong = await calcPost(post('/api/calc', { queries: [{ tax: 'vat' }] }));
    expect(wrong.status).toBe(400);
    const month13 = await calcPost(
      post('/api/calc', { queries: [{ ...feb, period: { kind: 'month', year: 2026, month: 13 } }] }),
    );
    expect(month13.status).toBe(422);
  });

  it('/api/export: .xlsx с именем файла и формулами; суммы равны расчёту', async () => {
    const q = encodeURIComponent(JSON.stringify({ queries: [feb], at: NOW }));
    const res = await atNow(() => exportGet(new NextRequest(`http://localhost/api/export?q=${q}`)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
    const dispo = res.headers.get('content-disposition')!;
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(dispo)![1]!)).toBe('НДС_Альфа_2026-02.xlsx');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Итог', 'По месяцам', 'Расчёт', 'Источник']);
    let formulas = 0;
    wb.getWorksheet('Расчёт')!.eachRow((row) =>
      row.eachCell((c) => {
        const v = c.value as { formula?: string } | null;
        if (v && typeof v === 'object' && typeof v.formula === 'string') formulas += 1;
      }),
    );
    expect(formulas).toBeGreaterThan(0);
    const expected = calcTax({ entityIds: ['alfa'], tax: 'vat', period: feb.period }, await data());
    let total: number | null = null;
    wb.getWorksheet('Итог')!.eachRow((row) => {
      if (row.getCell(1).value === 'Итого') total = (row.getCell(5).value as { result: number }).result;
    });
    expect(total).not.toBeNull();
    expect((total as unknown as number).toFixed(2)).toBe(expected.total!.toFixed(2));
  });

  it('/api/export: плохой запрос не отдаёт файл', async () => {
    const res = await exportGet(new NextRequest('http://localhost/api/export?q=%7B%7D'));
    expect(res.status).toBe(400);
    const none = await exportGet(new NextRequest('http://localhost/api/export'));
    expect(none.status).toBe(400);
  });

  it('справочник получателей: вымышленные бухгалтер и финансовый директор', async () => {
    const rows = await db.select().from(people).orderBy(people.sort);
    expect(rows.map((p) => p.role)).toEqual(['Бухгалтер', 'Финансовый директор', 'Налоговый консультант']);
    expect(rows.every((p) => p.name.split(' ').length === 2)).toBe(true);
    const res = await reviewsGet(new NextRequest('http://localhost/api/reviews'));
    const body = (await res.json()) as { people: { id: string }[]; requests: unknown[] };
    expect(body.people.map((p) => p.id)).toEqual(['demo-accountant', 'demo-cfo', 'demo-consultant']);
  });

  it('передача специалисту: запись review_requests со снимком и Excel, статус «Отправлено на проверку»', async () => {
    const before = (await db.select().from(reviewRequests)).length;
    const res = await atNow(() =>
      reviewsPost(
        post('/api/reviews', {
          target: { queries: [feb], at: NOW },
          recipientId: 'demo-accountant',
          comment: '  Проверьте ставку  ',
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request: { id: string; status: string; statusLabel: string }; demo: boolean };
    expect(body.demo).toBe(true);
    expect(body.request.status).toBe('sent');
    expect(body.request.statusLabel).toBe('Отправлено на проверку');

    const rows = await db.select().from(reviewRequests);
    expect(rows).toHaveLength(before + 1);
    const r = rows.find((x) => x.id === body.request.id)!;
    expect(r).toMatchObject({
      type: 'calc',
      status: 'sent',
      recipientId: 'demo-accountant',
      comment: 'Проверьте ставку',
      createdBy: userId,
      title: 'НДС, ООО «Альфа», февраль 2026',
      excelName: 'НДС_Альфа_2026-02.xlsx',
    });
    expect(r.excelFile.subarray(0, 2).toString()).toBe('PK');
    const snap = r.snapshot as { total: string; tax: string; steps: unknown[] }[];
    const expected = calcTax({ entityIds: ['alfa'], tax: 'vat', period: feb.period }, await data());
    expect(snap[0]!.total).toBe(expected.total!.toString());
    expect(snap[0]!.steps.length).toBeGreaterThan(0);

    // файл запроса отдаётся по номеру
    const file = await exportGet(new NextRequest(`http://localhost/api/export?review=${r.id}`));
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(r.excelFile)).toBe(true);

    // история запросов
    const list = await reviewsGet(new NextRequest('http://localhost/api/reviews'));
    const items = ((await list.json()) as { requests: { id: string; recipient: { name: string } }[] }).requests;
    expect(items.find((x) => x.id === r.id)?.recipient.name).toBe('Елена Образцова');
  });

  it('передача: неизвестный получатель и пустой расчёт отклоняются, записи не создаются', async () => {
    const before = (await db.select().from(reviewRequests)).length;
    const unknown = await reviewsPost(
      post('/api/reviews', { target: { queries: [feb], at: NOW }, recipientId: 'nobody', comment: '' }),
    );
    expect(unknown.status).toBe(404);
    const invalid = await reviewsPost(post('/api/reviews', { target: { queries: [] }, recipientId: 'demo-cfo' }));
    expect(invalid.status).toBe(400);
    const missing = await reviewsPost(post('/api/reviews', { target: { message: 999999 }, recipientId: 'demo-cfo' }));
    expect(missing.status).toBe(404);
    expect((await db.select().from(reviewRequests)).length).toBe(before);
  });

  it('отметки «сверил»: поставить, прочитать, обновить сумму, снять', async () => {
    const subject = 'vat:ytd2026:all:sel';
    const put = (checked: boolean, amount: string | null) =>
      checksPost(post('/api/checks', { subject, item: '0:src', checked, amount }));
    const read = async () => {
      const res = await checksGet(new NextRequest(`http://localhost/api/checks?subject=${encodeURIComponent(subject)}`));
      return ((await res.json()) as { marks: { item: string; amount: string | null; checkedAt: string }[] }).marks;
    };

    const first = await put(true, '100.50');
    expect(((await first.json()) as { mark: { item: string } }).mark.item).toBe('0:src');
    let marks = await read();
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ item: '0:src', amount: '100.50' });

    // повторная отметка обновляет сумму и время, строка одна
    await put(true, '120.00');
    marks = await read();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.amount).toBe('120.00');
    const rows = await db.select().from(checks).where(eq(checks.subject, subject));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);

    await put(false, null);
    expect(await read()).toEqual([]);
  });
});

describe('чат: расчёты ответа сохраняются снимками', () => {
  it('ответ о сумме налога несёт строку происхождения, снимки лежат в базе, лента их не возвращает', async () => {
    const out = await handleChat(db, { userId, question: 'НДС по Альфе за февраль', nowMs: NOW });
    expect(out.agent.fromCalc).toBe(true);
    expect(out.agent.provenance).not.toBeNull();
    expect(sourceLineText(out.agent.provenance!.line)).toBe('Выгрузка из 1С · обновлено 10.10, 18:00 · факт');
    expect(out.agent.provenance!.count).toBe(1);

    const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, out.agent.id));
    const stored = (row!.calc as { results: { total: string; at: number }[] }).results;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.at).toBe(NOW);
    const expected = calcTax({ entityIds: ['alfa'], tax: 'vat', period: feb.period }, await data());
    expect(stored[0]!.total).toBe(expected.total!.toString());

    // лента отдаёт строку, но не снимки
    const history = await loadHistory(db, userId);
    const turn = history.find((t) => t.id === out.agent.id)!;
    expect(turn.provenance?.count).toBe(1);
    expect(JSON.stringify(turn)).not.toContain('"steps"');

    // панель и Excel по номеру ответа
    const calc = await calcPost(post('/api/calc', { message: out.agent.id }));
    expect(calc.status).toBe(200);
    const items = ((await calc.json()) as { items: { total: string }[] }).items;
    expect(items[0]!.total).toBe(expected.total!.toString());
    const file = await exportGet(new NextRequest(`http://localhost/api/export?message=${out.agent.id}`));
    expect(file.status).toBe(200);
    const other = await calcPost(post('/api/calc', { message: out.user.id }));
    expect(other.status).toBe(404); // это вопрос пользователя, расчёта у него нет
  });

  it('ответ без расчёта (приветствие) без строки происхождения и действий', async () => {
    const out = await handleChat(db, { userId, question: 'привет', nowMs: NOW + 5_000 });
    expect(out.agent.provenance).toBeNull();
    const none = await calcPost(post('/api/calc', { message: out.agent.id }));
    expect(none.status).toBe(404);
  });

  it('УСН и налог на прибыль по группе: два расчёта в одном ответе, вся группа', async () => {
    const out = await handleChat(db, { userId, question: 'налог на прибыль за год', nowMs: NOW + 10_000 });
    expect(out.agent.provenance?.count).toBe(2);
    expect(out.agent.provenance!.line.scope).toBe('Вся группа');
    expect(out.agent.provenance!.line.period).toBe('2026 год');
  });
});

describe('миграция 0003 только добавляет', () => {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const statements = (file: string) =>
    fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

  it('в файле нет ничего, что удаляет или переписывает', () => {
    const list = statements('0003_provenance_actions.sql');
    expect(list.length).toBeGreaterThan(0);
    for (const st of list) {
      expect(st, st).toMatch(/^(CREATE TABLE|CREATE INDEX|ALTER TABLE "[a-z_]+" ADD (COLUMN|CONSTRAINT))/);
      const body = st.replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null)/gi, '');
      expect(body, st).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b|ALTER COLUMN/i);
    }
  });

  it('данные, записанные до миграции, сохраняются', async () => {
    const old = new PGlite();
    try {
      for (const f of ['0000_init.sql', '0001_tax_regimes.sql', '0002_data_sources.sql']) {
        for (const st of statements(f)) await old.exec(st);
      }
      await old.exec(`insert into legal_entities (id, name, form, owner_label, vat_status, annual_revenue, input_vat_share, color)
                      values ('alfa', 'ООО «Альфа»', 'ООО', 'Собственник 1', 'payer', 28400000, 0.82, '#000000')`);
      await old.exec(`insert into revenue_monthly (entity_id, year, month, amount, is_fact)
                      values ('alfa', 2026, 1, 1988000.00, true)`);
      for (const st of statements('0003_provenance_actions.sql')) await old.exec(st);

      const rows = await old.query<{ amount: string }>('select amount from revenue_monthly');
      expect(rows.rows).toEqual([{ amount: '1988000.00' }]);
      for (const t of ['people', 'checks', 'review_requests']) {
        const res = await old.query(`select count(*)::int as n from ${t}`);
        expect(res.rows).toEqual([{ n: 0 }]);
      }
      // ограничения: тип запроса и статус
      await old.exec(`insert into people (id, name, role) values ('p', 'Имя Фамилия', 'Бухгалтер')`);
      await old.exec(`insert into users (id, login, password_hash) values (gen_random_uuid(), 'u', 'x')`);
      await expect(
        old.exec(`insert into review_requests (created_by, recipient_id, title, snapshot, excel_name, excel_file, type)
                  select id, 'p', 't', '[]', 'f.xlsx', '\\x00', 'other' from users`),
      ).rejects.toThrow();
      await expect(
        old.exec(`insert into review_requests (created_by, recipient_id, title, snapshot, excel_name, excel_file, status)
                  select id, 'p', 't', '[]', 'f.xlsx', '\\x00', 'bogus' from users`),
      ).rejects.toThrow();
    } finally {
      await old.close();
    }
  });
});

