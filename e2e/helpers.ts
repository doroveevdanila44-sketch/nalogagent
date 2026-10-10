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

/** Чистая история чата и счётчики по кругу: тесты разных файлов делят одну базу. */
export async function resetChat(): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  await client.query('delete from chat_messages');
  await client.query('delete from agent_state');
  await client.end();
}
