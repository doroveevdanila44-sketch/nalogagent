import { test } from '@playwright/test';
import { firstLogin, fillPassword, typePin } from './helpers';

// Снимки для визуальной проверки. Запуск: SCREENS=1 npx playwright test e2e/screens.spec.ts
test.skip(!process.env.SCREENS, 'только по запросу');
test.describe.configure({ mode: 'serial' });

const OUT = '.data/shots';

test('экраны на 390, 768, 1440', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-login-390.png` });

  await fillPassword(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-pin-setup-390.png` });
  await typePin(page, '8246');
  await page.waitForTimeout(300);
  await typePin(page, '8246');
  await page.waitForTimeout(1200);

  // пустой чат
  await page.screenshot({ path: `${OUT}/03-agent-empty-390.png` });

  const input = page.getByLabel('Вопрос агенту');
  await page.getByRole('button', { name: 'Какая ставка выгоднее?' }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/04-agent-answer-390.png` });
  await input.fill('Что если Альфа купит 3 машины по 7 млн?');
  await input.press('Enter');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/05-agent-scenario-390.png` });

  await page.getByRole('link', { name: 'Дашборд' }).click();
  await page.waitForTimeout(1200);
  for (let i = 0; i < 7; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * 740);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/06-dashboard-390-${i}.png` });
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/07-menu-390.png` });
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('button', { name: 'Заблокировать на PIN' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/08-locked-390.png` });
  await typePin(page, '8246');
  await page.waitForTimeout(800);

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/09-dashboard-768.png`, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/10-dashboard-1440.png`, fullPage: true });
  await page.getByRole('link', { name: 'Агент' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/11-agent-1440.png` });

  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/12-dashboard-360.png`, fullPage: true });
});
