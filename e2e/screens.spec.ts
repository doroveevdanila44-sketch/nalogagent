import { test } from '@playwright/test';
import { fillPassword, firstLogin, typePin } from './helpers';

// Снимки для визуальной проверки. Запуск: SCREENS=1 npx playwright test e2e/screens.spec.ts
test.skip(!process.env.SCREENS, 'только по запросу');
test.describe.configure({ mode: 'serial' });

const OUT = '.data/shots';

test('экраны на 390, 768, 1440', async ({ page }) => {
  // вход
  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/login');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/ui-login-${w}.png` });
  }

  await firstLogin(page, '8246');
  await page.reload();
  await page.getByRole('heading', { name: 'Введите PIN' }).waitFor();
  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/ui-pin-${w}.png` });
  }
  await typePin(page, '8246');
  await page.waitForTimeout(1200);

  // агент с ответом
  const input = page.getByLabel('Вопрос агенту');
  await page.getByRole('button', { name: 'Какая ставка выгоднее?' }).first().click();
  await page.waitForTimeout(1000);
  await input.fill('Что если Альфа купит 3 машины по 7 млн?');
  await input.press('Enter');
  await page.waitForTimeout(1000);
  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/ui-agent-${w}.png` });
  }

  // меню трёх точек
  for (const w of [390, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.getByRole('button', { name: 'Меню' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/ui-menu-${w}.png` });
    await page.keyboard.press('Escape');
  }

  // дашборд
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await page.waitForTimeout(1200);
  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}/ui-dash-${w}.png` });
  }

  // график с подсвеченным сегментом
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.chart').scrollIntoViewIfNeeded();
  await page.locator('.plot .col').nth(7).locator('button.seg').nth(1).hover();
  await page.waitForTimeout(350);
  await page.locator('.chart').screenshot({ path: `${OUT}/ui-chart-hover-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.plot .col').nth(9).locator('button.seg').nth(0).click();
  await page.waitForTimeout(350);
  await page.locator('.chart').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/ui-chart-pick-390.png` });
});
