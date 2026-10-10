import { test } from '@playwright/test';
import { firstLogin } from './helpers';

// Снимки для визуальной проверки. Запуск: SCREENS=1 npx playwright test e2e/screens.spec.ts
test.skip(!process.env.SCREENS, 'только по запросу');
test.describe.configure({ mode: 'serial' });

const OUT = '.data/shots';

test('дашборд и агент на 390, 768, 1440', async ({ page }) => {
  await firstLogin(page, '8246');
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await page.locator('.sum-card').first().waitFor();
  await page.waitForTimeout(800);

  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/t1-dash-top-${w}.png` });
  }

  // раскрытая расшифровка
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('.sum-card').nth(3).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t1-dash-detail-390.png` });
  await page.locator('.sum-card').nth(3).click();

  // график на телефоне
  await page.locator('.chart').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator('.chart').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/t1-chart-390.png` });
  await page.locator('.plot .col').nth(9).locator('button.seg').nth(1).click({ force: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/t1-chart-pick-390.png` });

  // карточки юрлиц
  await page.locator('article.ent', { hasText: 'ООО «Эпсилон»' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t1-ent-epsilon-390.png` });
  await page.locator('article.ent', { hasText: 'ИП Бета' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t1-ent-beta-390.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.locator('article.ent', { hasText: 'ООО «Эпсилон»' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/t1-ent-1440.png` });
  await page.locator('.chart').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/t1-chart-1440.png` });

  // агент: налог на прибыль
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Агент' }).click();
  await page.getByRole('button', { name: 'Налог на прибыль за год?' }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/t1-agent-profit-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t1-agent-profit-1440.png` });
});
