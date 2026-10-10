import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import fs from 'node:fs';
import { E2E_DB_URL, SERVER_LOG } from '../playwright.config';
import { LOGIN, firstLogin, fillPassword, ownerPassword, typePin } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

test('1. без входа открыта только страница /login', async ({ page, request }) => {
  for (const path of ['/agent', '/dashboard', '/']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
  expect((await request.get('/api/dashboard')).status()).toBe(401);
  expect((await request.get('/api/chat')).status()).toBe(401);
  expect((await request.get('/api/auth/state')).status()).toBe(200);
  expect((await request.get('/manifest.webmanifest')).status()).toBe(200);
  expect((await request.get('/login')).status()).toBe(200);
});

test('2. неверный пароль и неверный логин: одинаковое сообщение', async ({ page }) => {
  await page.goto('/login');
  await fillPassword(page, 'definitely-wrong');
  await expect(page.getByRole('alert').filter({ hasText: 'Неверный логин или пароль' })).toBeVisible();
  await page.getByLabel('Логин', { exact: true }).fill('someone-else');
  await page.getByLabel('Пароль', { exact: true }).fill(ownerPassword());
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Неверный логин или пароль' })).toBeVisible();
});

test('3. первый вход: PIN создаётся дважды, запрещённые PIN отклоняются, cookies', async ({ page, context }) => {
  await page.goto('/login');
  // логин без учёта регистра и с пробелами
  await fillPassword(page, ownerPassword(), `  ${LOGIN.toUpperCase()} `);
  await expect(page.getByRole('heading', { name: 'Придумайте PIN из 4 цифр' })).toBeVisible();

  // запрещённый PIN
  await typePin(page, '1234');
  await expect(page.getByText('Выберите менее очевидный PIN')).toBeVisible();

  // повтор не совпал
  await typePin(page, PIN);
  await expect(page.getByRole('heading', { name: 'Повторите PIN' })).toBeVisible();
  await typePin(page, '8247');
  await expect(page.getByText('PIN не совпал')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Придумайте PIN из 4 цифр' })).toBeVisible();

  await typePin(page, PIN);
  await expect(page.getByRole('heading', { name: 'Повторите PIN' })).toBeVisible();
  await typePin(page, PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');

  // ни пароль, ни PIN не в URL и не в localStorage
  expect(page.url()).not.toContain(PIN);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(PIN);
  expect(storage).not.toContain(ownerPassword());

  const cookies = await context.cookies();
  const device = cookies.find((c) => c.name === 'pva_device')!;
  const session = cookies.find((c) => c.name === 'pva_session')!;
  expect(device.httpOnly).toBe(true);
  expect(device.sameSite).toBe('Lax');
  expect(device.secure).toBe(true);
  expect(device.expires).toBeGreaterThan(Date.now() / 1000 + 170 * 86400);
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Lax');
  expect(session.secure).toBe(true);
  expect(session.expires).toBe(-1); // сессионная, без срока
});

test('4. повторный вход по PIN, ошибки, блокировка после пяти, вход по паролю снимает', async ({ page }) => {
  await firstLogin(page, PIN);

  // закрытие вкладки блокирует: после перезагрузки нужен PIN
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();

  await typePin(page, '1357');
  await expect(page.getByText('Неверный PIN. Осталось попыток: 4')).toBeVisible();
  await typePin(page, PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');

  await page.reload();
  for (let left = 4; left >= 1; left--) {
    await typePin(page, '1357');
    await expect(page.getByText(`Осталось попыток: ${left}`)).toBeVisible();
  }
  // пока PIN не заблокирован, «Войти по паролю» на экране нет
  await expect(page.getByRole('button', { name: 'Войти по паролю' })).toHaveCount(0);
  await typePin(page, '1357');
  // пятая ошибка: PIN заблокирован, экран PIN остаётся, слева появляется единственный выход
  await expect(page.getByText('PIN заблокирован')).toBeVisible();
  const toPassword = page.getByRole('button', { name: 'Войти по паролю' });
  await expect(toPassword).toBeVisible();
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
  await toPassword.click();
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();
  await expect(page.getByText('PIN заблокирован')).toBeVisible();

  // старый PIN уже не помогает, вход по паролю требует новый PIN
  await fillPassword(page);
  await expect(page.getByRole('heading', { name: 'Придумайте PIN из 4 цифр' })).toBeVisible();
  await typePin(page, '2580');
  await expect(page.getByRole('heading', { name: 'Повторите PIN' })).toBeVisible();
  await typePin(page, '2580');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
});

test('5. блокировка замком: экран PIN поверх, API отвечает 401 до ввода PIN', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible();

  const locked = await page.request.get('/api/dashboard');
  expect(locked.status()).toBe(401);
  expect((await locked.json()).code).toBe('locked');

  await typePin(page, PIN);
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeHidden();
  expect((await page.request.get('/api/dashboard')).status()).toBe(200);
});

test('6. простой: блокировка на PIN сама', async ({ page }) => {
  await firstLogin(page, PIN);
  // PIN_IDLE_MINUTES=0.25 для e2e-сервера, то есть 15 секунд без действий
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible({ timeout: 25_000 });
  expect((await page.request.get('/api/dashboard')).status()).toBe(401);
});

test('7. выход стирает устройство и PIN', async ({ page, context }) => {
  await firstLogin(page, PIN);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).not.toContain('pva_device');
});

test('8. ловушка: пароль и PIN не появляются в базе, логах и ответах', async ({ page }) => {
  const TRAP_PIN = '6153';
  const bodies: string[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/auth/')) {
      try {
        bodies.push(await res.text());
      } catch {
        // тело недоступно у редиректов
      }
    }
  });
  await firstLogin(page, TRAP_PIN);
  await page.reload();
  await typePin(page, '1357');
  await expect(page.getByText('Неверный PIN. Осталось попыток: 4')).toBeVisible();
  await typePin(page, TRAP_PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login/);

  const password = ownerPassword();
  const pinRe = new RegExp(`(?<!\\d)${TRAP_PIN}(?!\\d)`);

  // ответы API
  const responses = bodies.join('\n');
  expect(responses).not.toContain(password);
  expect(pinRe.test(responses)).toBe(false);

  // журнал сервера
  const log = fs.readFileSync(SERVER_LOG, 'utf8');
  expect(log).not.toContain(password);
  expect(pinRe.test(log)).toBe(false);

  // вся база
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  const tables = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
  );
  let dump = '';
  for (const { table_name } of tables.rows) {
    const rows = await client.query(`select * from "${table_name}"`);
    dump += JSON.stringify(rows.rows);
  }
  await client.end();
  dump = dump
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TS');
  expect(dump).not.toContain(password);
  expect(pinRe.test(dump)).toBe(false);
});
