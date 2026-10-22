import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, holdSession, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

// Телефон 390 px, касание: как мобильный Safari по размеру и вводу
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Состояние «обучение» в базе (user_prefs): строки нет, время пусто или время закрытия. */
async function setPrefs(state: 'none' | 'null' | 'seen'): Promise<void> {
  await sql('delete from user_prefs');
  if (state === 'none') return;
  await sql(`insert into user_prefs (user_id, onboarding_seen_at) select id, $1 from users`, [
    state === 'seen' ? new Date() : null,
  ]);
}

test.afterAll(async () => {
  await setPrefs('seen');
  await resetChat();
});

/** Всё, что видно в консоли и как ошибки страницы: по этому смотрим, что вкладка не падала. */
function watch(page: Page): string[] {
  const log: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') log.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message.slice(0, 300)}`));
  return log;
}

const appError = (page: Page) => page.getByTestId('app-error');

test('обучение: /agent открывается при любом состоянии user_prefs, тур не падает', async ({ page }) => {
  const log = watch(page);
  await setPrefs('seen');
  await firstLogin(page, PIN);
  await holdSession();

  // строки нет и время пусто: обучение показывается с первого шага; пройдено: не показывается
  for (const state of ['none', 'null', 'seen'] as const) {
    await setPrefs(state);
    await holdSession();
    await page.goto('/agent');
    for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click().catch(() => undefined);
    await expect(page.locator('.chat-root')).toBeVisible();
    await holdSession();
    if (state === 'seen') {
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('tour')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('tour')).toBeVisible();
      await expect(page.getByTestId('tour')).toHaveAttribute('data-index', '0');
      await expect(page.getByTestId('tour-count')).toHaveText('Шаг 1 из 8');
      // листаем вперёд и назад, потом закрываем: номер шага остаётся в границах
      const card = page.getByTestId('tour-card');
      for (let i = 0; i < 3; i++) {
        await holdSession();
        await card.getByRole('button', { name: /^(Дальше|Готово)$/ }).click();
        await page.waitForTimeout(700);
      }
      await card.getByRole('button', { name: 'Назад' }).click();
      const idx = Number(await page.getByTestId('tour').getAttribute('data-index'));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
      await card.getByRole('button', { name: /Пропустить/ }).click();
      await expect(page.getByTestId('tour')).toHaveCount(0);
    }
    await expect(appError(page)).toHaveCount(0);
  }
  expect(log.filter((l) => l.startsWith('pageerror'))).toEqual([]);
});

test('чат: сохранённые прежними версиями сообщения не роняют вкладку «Агент»', async ({ page }) => {
  await resetChat();
  await setPrefs('seen');
  await firstLogin(page, PIN);
  const [{ id: userId }] = await sql<{ id: string }>('select id from users limit 1');

  const U = { entity: 'ООО «Альфа»', tax: 'НДС', period: '2026', kind: 'year', kindLabel: 'факт' };
  // каждый вид сохранён так, как мог записать прежний код: без поля, с пустым, с null вместо объекта
  const stored: Record<string, unknown> = {
    'без допущений': { understood: U },
    'пустое понимание': { understood: {} },
    'изменить без списков': { understood: { ...U, notes: [] }, change: { entity: [] } },
    'кнопка null': { quick: [null, { label: 'Альфа', text: 'по Альфе' }] },
    'пустая карточка': { understood: { ...U, notes: [] }, form: {} },
    'таблица {}': { tables: [{}] },
    'таблица null': { tables: [null] },
    'строки null': { tables: [{ head: ['a'], rows: null }] },
    'как посчитано текстом': { how: 'abc' },
    'обычный ответ': {},
  };
  for (const [name, calc] of Object.entries(stored)) {
    await sql(`insert into chat_messages (user_id, role, class, content, calc) values ($1, 'agent', 'A', $2, $3::jsonb)`, [
      userId,
      `ответ: ${name}`,
      JSON.stringify(calc),
    ]);
  }

  const log = watch(page);
  await holdSession();
  await page.goto('/agent');
  for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click().catch(() => undefined);
  await expect(page.locator('.chat-root')).toBeVisible();
  await expect(page.locator('.msg').first()).toBeVisible();

  // сервер приводит сохранённое к виду, который разберёт разметка: страница открыта, все ответы на месте
  await expect(appError(page)).toHaveCount(0);
  for (const name of Object.keys(stored)) await expect(page.getByText(`ответ: ${name}`)).toBeVisible();
  await expect(page.getByTestId('msg-fallback')).toHaveCount(0);
  expect(log).toEqual([]);

  // сервер отдал недостающее пустым: «Понял так» без допущений показана
  await holdSession();
  const history = await page.request.get('/api/chat');
  const turns = (await history.json()).messages as { text: string; understood: { notes: string[] } | null; quick: unknown[]; tables: unknown[]; how: unknown[] }[];
  const by = (name: string) => turns.find((t) => t.text === `ответ: ${name}`)!;
  expect(by('без допущений').understood?.notes).toEqual([]);
  expect(by('пустое понимание').understood).toBeNull();
  expect(by('кнопка null').quick).toEqual([{ label: 'Альфа', text: 'по Альфе' }]);
  expect(by('таблица {}').tables).toEqual([]);
  expect(by('как посчитано текстом').how).toEqual([]);

  // поле ввода работает
  await page.getByLabel('Вопрос агенту').fill('Что с порогами?');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(appError(page)).toHaveCount(0);
});

test('чат: сообщение, которое не отрисовалось, показывается текстом, остальные и поле работают', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);
  // сломанное сообщение приходит мимо сервера (обновили клиент, а ответ собран иначе): граница вокруг сообщения
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const base = { class: 'A', fromCalc: false, createdAt: new Date().toISOString(), provenance: null, form: null };
    await route.fulfill({
      json: {
        messages: [
          { ...base, id: 1, role: 'user', text: 'вопрос', tables: [], how: [], understood: null, quick: [], change: null },
          { ...base, id: 2, role: 'agent', text: 'сломанный ответ', tables: null, how: null, understood: {}, quick: null, change: null },
          { ...base, id: 3, role: 'agent', text: 'целый ответ', tables: [], how: [], understood: null, quick: [], change: null },
        ],
      },
    });
  });
  const log = watch(page);
  await holdSession();
  await page.goto('/agent');
  for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click().catch(() => undefined);
  await expect(page.getByText('целый ответ')).toBeVisible();
  await expect(appError(page)).toHaveCount(0);
  await expect(page.getByTestId('msg-fallback')).toHaveCount(1);
  await expect(page.getByTestId('msg-fallback')).toHaveText('сломанный ответ');
  // причина в консоли: номер сообщения, имя и сообщение ошибки, без стека
  expect(log.some((l) => l.includes('[chat] сообщение 2 показано текстом из-за ошибки'))).toBe(true);
  await page.getByLabel('Вопрос агенту').fill('ещё вопрос');
  await expect(page.getByRole('button', { name: 'Отправить' })).toBeEnabled();
});

test('граница страницы: экран ошибки прежний, причина и digest пишутся в консоль, текста ошибки на экране нет', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);
  // ответ истории не того вида: сбой при отрисовке самой ленты (вне сообщения), её ловит error.tsx
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { messages: 5 } });
  });
  const log = watch(page);
  await holdSession();
  await page.goto('/agent');
  for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click().catch(() => undefined);
  await expect(appError(page)).toBeVisible();
  await expect(appError(page).getByRole('heading', { name: 'Что-то пошло не так' })).toBeVisible();
  await expect(appError(page)).toContainText('Страница не открылась. Повторите, цифры при этом не потеряны.');
  // на экране ни имени ошибки, ни сообщения, ни стека
  const shown = (await page.locator('body').innerText()).toLowerCase();
  for (const leak of ['typeerror', 'is not a function', 'at ', 'webpack', '.js:']) expect(shown).not.toContain(leak);
  const mine = log.find((l) => l.includes('[app-error]'));
  expect(mine, log.join('\n')).toBeTruthy();
  expect(mine).toContain('digest');
  expect(mine).toMatch(/TypeError|is not a function/);
  expect(mine).not.toMatch(/\n\s+at /);
});
