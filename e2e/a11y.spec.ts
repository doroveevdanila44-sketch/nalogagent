import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstLogin } from './helpers';

const PIN = '8246';

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // Знак luxauto41: «41» цвета Afternoon Tea на янтарной шапке (3,4:1) задан клиентом.
    // Для логотипов WCAG 1.4.3 не требует минимального контраста (см. docs/DECISIONS.md).
    .exclude('.wordmark')
    .analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')}`);
}

test.describe.configure({ mode: 'serial' });

test('доступность: вход, PIN, агент, дашборд, меню, блокировка', async ({ page }) => {
  const found: string[] = [];
  const check = async (label: string) => {
    for (const v of await violations(page)) found.push(`${label}: ${v}`);
  };

  await page.goto('/login');
  await check('login');

  await firstLogin(page, PIN);
  await page.getByLabel('Вопрос агенту').waitFor();
  await check('agent empty');

  await page.getByRole('button', { name: 'Какая ставка выгоднее?' }).first().click();
  await expect(page.getByText('Цифры из калькулятора')).toBeVisible();
  await check('agent answer');

  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await check('dashboard');

  await page.getByRole('button', { name: 'Меню' }).click();
  await check('menu');
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible();
  await check('locked');

  expect(found).toEqual([]);
});

test('консоль без ошибок на основных экранах', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('link', { name: 'Агент' }).click();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
