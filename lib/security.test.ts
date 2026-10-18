import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Регрессионные проверки по аудиту безопасности и устойчивости: чужие и кривые идентификаторы не
 * роняют сервер (500), а дают 404 или 400, числа вне диапазона базы отсекаются до запроса, очистка
 * чата стирает только свои сообщения.
 */
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

import { POST as calcPost } from '@/app/api/calc/route';
import { POST as chatPost, GET as chatGet, DELETE as chatDelete } from '@/app/api/chat/route';
import { POST as restorePost } from '@/app/api/documents/restore/route';
import { POST as deletePost } from '@/app/api/documents/delete/route';
import { GET as docGet } from '@/app/api/documents/[id]/route';
import { createOwner } from '@/lib/auth/service';
import { handleChat, loadHistory } from '@/lib/agent/service';
import type { Db } from '@/lib/db/client';
import { agentState, chatMessages, documents, llmUsage, reviewRequests, users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { DocError, createDocument, downloadDocument, getDocument, restoreDocuments } from '@/lib/documents/service';
import { eq } from 'drizzle-orm';

let db: Db;
let close: () => Promise<void>;
let userA: string;
let userB: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedDatabase(db);
  await createOwner(db, { login: 'owner-a', password: 'x-test-password-aaaa' });
  await createOwner(db, { login: 'owner-b', password: 'x-test-password-bbbb' });
  const rows = await db.select({ id: users.id, login: users.login }).from(users);
  userA = rows.find((r) => r.login === 'owner-a')!.id;
  userB = rows.find((r) => r.login === 'owner-b')!.id;
  h.db = db;
  h.user = userA;
});
afterAll(async () => close());

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const BAD_IDS = [
  '------------------------------------',
  'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
  '00000000-0000-0000-0000-00000000000g',
  "'; drop table documents; --",
  '../../etc/passwd',
  '',
];

describe('идентификаторы документов', () => {
  it('кривой id даёт 404 «Документ не найден», а не сбой базы', async () => {
    for (const id of BAD_IDS) {
      await expect(getDocument(db, { userId: userA, id, tz: 'Asia/Kamchatka' }), id).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('возврат и удаление с кривым id тоже 404', async () => {
    for (const id of BAD_IDS.filter(Boolean)) {
      await expect(restoreDocuments(db, { userId: userA, ids: [id], nowMs: Date.now() }), id).rejects.toBeInstanceOf(DocError);
    }
  });

  it('маршруты возврата и удаления отклоняют не-UUID ещё до базы (400)', async () => {
    for (const route of [restorePost, deletePost]) {
      const res = await route(post('/api/documents/x', { ids: ['not-a-uuid'] }));
      expect(res.status).toBe(400);
    }
  });

  it('номер версии вне диапазона int не роняет запрос', async () => {
    const doc = await createDocument(db, {
      userId: userA,
      templateKey: 'report_vat_certificate',
      entityId: 'alfa',
      period: { kind: 'month', year: 2026, month: 3 },
      nowMs: Date.UTC(2026, 9, 14),
      tz: 'Asia/Kamchatka',
    });
    for (const version of [1e12, 2 ** 31, 99999999999]) {
      await expect(
        getDocument(db, { userId: userA, id: doc, version, tz: 'Asia/Kamchatka' }),
        String(version),
      ).rejects.toMatchObject({ status: 404 });
    }
    const res = docGet(new NextRequest(`http://localhost/api/documents/${doc}?version=99999999999`), {
      params: Promise.resolve({ id: doc }),
    });
    await expect(res).resolves.toMatchObject({ status: 404 });
  });
});

describe('числа вне диапазона базы', () => {
  it('номер ответа чата больше bigint отклоняется схемой, а не базой', async () => {
    const res = await calcPost(post('/api/calc', { message: 1e30 }));
    expect(res.status).toBe(400);
  });

  it('baseId в чате больше bigint отклоняется (400)', async () => {
    const res = await chatPost(post('/api/chat', { message: 'привет', baseId: 1e30 }));
    expect(res.status).toBe(400);
  });

  it('handleChat не падает на огромном baseId и просто не находит ответ', async () => {
    const r = await handleChat(db, { userId: userA, question: 'привет', baseId: 2 ** 53 - 1 });
    expect(r.agent.text.length).toBeGreaterThan(0);
  });
});

describe('очистка чата', () => {
  it('стирает все сообщения владельца, чужие не трогает', async () => {
    await handleChat(db, { userId: userA, question: 'привет' });
    await handleChat(db, { userId: userA, question: 'Какая ставка выгоднее?' });
    await handleChat(db, { userId: userB, question: 'привет' });
    expect((await loadHistory(db, userA)).length).toBeGreaterThanOrEqual(4);
    const beforeB = (await loadHistory(db, userB)).length;
    expect(beforeB).toBeGreaterThanOrEqual(2);

    h.user = userA;
    const res = await chatDelete(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBeGreaterThanOrEqual(4);

    expect(await loadHistory(db, userA)).toEqual([]);
    expect((await loadHistory(db, userB)).length).toBe(beforeB);
    // запрос истории после очистки пуст
    const hist = (await (await chatGet(new NextRequest('http://localhost/api/chat'))).json()) as { messages: unknown[] };
    expect(hist.messages).toEqual([]);
  });

  it('после очистки агент не помнит прежний вопрос и считает сессию новой', async () => {
    await handleChat(db, { userId: userA, question: 'сколько НДС платить' });
    await chatDelete(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));
    const [state] = await db.select().from(agentState).where(eq(agentState.userId, userA));
    expect(state!.lastActive).toBeNull();
    // короткий ответ «февраль» без прежнего вопроса не продолжает старый расчёт
    const r = await handleChat(db, { userId: userA, question: 'февраль' });
    expect(r.agent.fromCalc).toBe(false);
  });

  it('очистка пустого чата не ошибка', async () => {
    await chatDelete(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));
    const res = await chatDelete(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(0);
  });

  it('запросы на проверку, документы и отметки остаются', async () => {
    const reviewsBefore = (await db.select({ id: reviewRequests.id }).from(reviewRequests)).length;
    await handleChat(db, { userId: userA, question: 'привет' });
    await chatDelete(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));
    const after = await db.select({ id: reviewRequests.id }).from(reviewRequests);
    expect(after.length).toBe(reviewsBefore);
    expect((await db.select({ id: documents.id }).from(documents)).length).toBeGreaterThanOrEqual(1);
    expect((await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.userId, userA))).length).toBe(0);
  });
});

describe('странный ввод в чате', () => {
  const phrases = [
    '0', '-1', '1e308', 'NaN', 'null', '{}', '<script>alert(1)</script>', "'; drop table users; --",
    '😀'.repeat(300), 'а'.repeat(1000), '\u0001\u0002\u001f', '\ud800', '\udfff', '‮RLO', '​​', '﻿BOM',
    'что если купим 0 машин', 'что если купим -5 машин по 3 млн', 'что если купим 1000000 машин',
    'что если купим 5 машин по 0 млн', 'что если купим 5 машин по 99999999999999999999 млн',
    'сдавать по 0 в сутки 5 машин', 'что если купим 5 машин по 3 млн сдавать по 9999999999 в сутки 99 дней',
    'а если купим 5 машин с декабря 2027', 'что если выручка вырастет на 1e5%', 'что если выручка упадет на 100%',
    'что если Дельта вырастет на 999999999999 млн', 'налог за 0000 год', 'налог за 9999 год', 'налог за 31 февраля',
    'налог с 32 марта по 1 января', 'налог за 13 квартал', 'прогноз на 2027 рост 1000000%', 'прогноз на 2027 падение 100%',
    'НДС за февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь', 'с декабря по январь',
  ];

  it('ни одна фраза не роняет конвейер и не оставляет сбоя в журнале', async () => {
    h.user = userA;
    let t = Date.UTC(2026, 9, 14);
    for (const q of phrases) {
      t += 60_000;
      const r = await handleChat(db, { userId: userA, question: q, nowMs: t });
      expect(r.agent.text, q).not.toMatch(/Не получилось выполнить расчёт|Не могу подтвердить расчёт/);
    }
    const notes = await db.select({ note: llmUsage.note }).from(llmUsage);
    expect(notes.filter((n) => n.note)).toEqual([]);
  });

  it('символ NUL: через API отклоняется (400), напрямую вырезается', async () => {
    const res = await chatPost(post('/api/chat', { message: 'при\u0000вет' }));
    expect(res.status).toBe(400);
    const nested = await calcPost(post('/api/calc', { queries: [{ tax: 'vat', period: { kind: 'ytd' }, entityIds: ['a\u0000'] }] }));
    expect(nested.status).toBe(400);
    const r = await handleChat(db, { userId: userA, question: 'при\u0000вет' });
    expect(r.user.text).toBe('привет');
  });
});

describe('служебные символы в тексте документов', () => {
  const wellFormed = (xml: string) => {
    const parser = new SaxesParser();
    let errors = 0;
    parser.on('error', () => (errors += 1));
    parser.write(xml).close();
    return errors === 0;
  };

  it('управляющие символы из вставленного текста не ломают .docx (XML остаётся корректным)', async () => {
    const id = await createDocument(db, {
      userId: userA,
      templateKey: 'contract_rent_no_crew',
      entityId: 'alfa',
      period: null,
      user: {
        contract_number: '12\u0001\u0008',
        car_description: 'Лада\u000b Веста\u000c\ufffe\uffff',
        lessee_name: 'ООО «Ромашка»\u001f',
        lessee_details: 'ИНН 1\n2\u0000\u0002\u0003',
        special_terms: 'Строка 1\nСтрока 2\tтаб\u0007',
      },
      nowMs: Date.UTC(2026, 9, 14),
      tz: 'Asia/Kamchatka',
    });
    const out = await downloadDocument(db, { userId: userA, id, tz: 'Asia/Kamchatka' });
    const zip = await JSZip.loadAsync(out.file);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(wellFormed(xml)).toBe(true);
    // обычные переносы и табы остаются, служебные символы убраны
    const detail = await getDocument(db, { userId: userA, id, tz: 'Asia/Kamchatka' });
    const value = (key: string) => detail.values[key]?.value ?? '';
    expect(value('special_terms')).toContain('Строка 1\nСтрока 2');
    expect(value('car_description')).toBe('Лада Веста');
    expect(value('contract_number')).toBe('12');
  });
});
