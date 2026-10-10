import { test } from '@playwright/test';
import { fillPassword, firstLogin } from './helpers';

// Снимки для визуальной проверки. Запуск: SCREENS=1 npx playwright test e2e/screens.spec.ts
test.skip(!process.env.SCREENS, 'только по запросу');
test.describe.configure({ mode: 'serial' });

const OUT = '.data/shots';

test('экран PIN на разных размерах', async ({ page }) => {
  // шаг «Придумайте PIN» с подписью
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/login');
  await fillPassword(page);
  await page.getByRole('heading', { name: 'Придумайте PIN из 4 цифр' }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/t2-setup-375x667.png` });
  for (const d of ['8', '2', '4', '6']) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('heading', { name: 'Повторите PIN' }).waitFor();
  for (const d of ['8', '2', '4', '6']) await page.getByRole('button', { name: d, exact: true }).click();
  await page.waitForURL('**/agent');

  await page.reload();
  await page.getByRole('heading', { name: 'Введите PIN' }).waitFor();
  const combos: [number, number][] = [
    [375, 667],
    [390, 844],
    [430, 932],
    [768, 1024],
    [430, 667],
    [375, 932],
    [768, 667],
    [1440, 900],
  ];
  for (const [w, h] of combos) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/t2-pin-${w}x${h}.png` });
  }

  // введены цифры: «Удалить» справа
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '1', exact: true }).click();
  await page.getByRole('button', { name: '3', exact: true }).click();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/t2-pin-digits-390x844.png` });

  // нажатая клавиша
  const key = page.getByRole('button', { name: '7', exact: true });
  await key.hover();
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.screenshot({ path: `${OUT}/t2-pin-pressed-390x844.png` });
  await page.mouse.up();

  // ошибка
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click().catch(() => undefined);
  for (const d of ['1', '3', '5', '7']) await page.getByRole('button', { name: d, exact: true }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/t2-pin-error-375x667.png` });

  // пароль
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Войти по паролю' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Логин', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t2-password-390x844.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/t2-password-1440x900.png` });
});
