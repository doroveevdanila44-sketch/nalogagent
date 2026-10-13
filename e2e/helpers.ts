import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';

export const LOGIN = 'luxautoowner';

export function ownerPassword(): string {
  return fs.readFileSync('.data/e2e-password', 'utf8').trim();
}

export async function typePin(page: Page, pin: string): Promise<void> {
  for (const d of pin) {
    await page.getByRole('button', { name: d, exact: true }).click();
  }
}

export async function fillPassword(page: Page, password = ownerPassword(), login = LOGIN): Promise<void> {
  await page.getByLabel('Логин', { exact: true }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/** Полный первый вход на новом устройстве: пароль, PIN, повтор PIN, открывается «Агент». */
export async function firstLogin(page: Page, pin: string): Promise<void> {
  await page.goto('/login');
  await fillPassword(page);
  await expect(page.getByRole('heading', { name: 'Придумайте PIN из 4 цифр' })).toBeVisible();
  await typePin(page, pin);
  await expect(page.getByRole('heading', { name: 'Повторите PIN' })).toBeVisible();
  await typePin(page, pin);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
}

/**
 * Нажимает подсказку над полем чата. На телефоне (до 760 px) блок свёрнут и раскрывается только
 * нажатием на ручку «Подсказки», поэтому сначала раскрывается он; после выбора блок сворачивается сам.
 */
export async function pickSuggestion(page: Page, name: string): Promise<void> {
  const handle = page.locator('.sug-handle');
  if ((await handle.count()) > 0 && (await handle.getAttribute('aria-expanded')) !== 'true') {
    await handle.click();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.getByRole('button', { name, exact: true }).first().click();
}

/** Год «сегодня» в часовом поясе приложения: по нему выбирается ставка в rate_choices. */
function appYear(): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka', year: 'numeric' }).format(new Date()));
}

/**
 * Выбранная ставка берётся из rate_choices, в интерфейсе её не сменить (нажатие на карточку ставки
 * ничего не делает). Тесты, которым нужна не пятипроцентная ставка, задают её прямо в базе.
 */
export async function setRateChoice(entityId: string, rate: 5 | 7 | 22): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  await client.query('insert into rate_choices (entity_id, year, rate) values ($1, $2, $3)', [
    entityId,
    appYear(),
    rate,
  ]);
  await client.end();
}

/** Чистая история чата и счётчики по кругу: тесты разных файлов делят одну базу. */
export async function resetChat(): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  await client.query('delete from chat_messages');
  await client.query('delete from agent_state');
  await client.end();
}

/**
 * Долгие сценарии (несколько создаваемых документов, ожидание уведомления на 8 секунд): в окружении
 * тестов сессия блокируется после 15 секунд без обращений к серверу (PIN_IDLE_MINUTES 0.25), а
 * «касание» активности записывается реже. Отметка активности уносится в будущее: сессия не
 * блокируется по простою, остальная блокировка (PIN при запуске, кнопка) работает как обычно.
 */
export async function holdSession(): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  await client.query(`update sessions set last_activity = now() + interval '1 day', locked_at = null`);
  await client.end();
}
