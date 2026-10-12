import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

/** Сколько раз слово встречается в тексте DOM страницы, включая скрытое. */
const count = (page: Page, word: string) =>
  page.evaluate((w) => (document.body.textContent ?? '').split(w).length - 1, word);

async function goTo(page: Page, tab: 'Агент' | 'Дашборд' | 'Документы') {
  await page.getByRole('link', { name: tab, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${tab === 'Агент' ? 'agent' : tab === 'Дашборд' ? 'dashboard' : 'documents'}$`));
}

for (const width of [390, 1440]) {
  test(`«Демо-данные» один раз на каждом экране и в окнах, ${width} px`, async ({ page }) => {
    await resetChat();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);

    // агент: пустой экран и после ответа с расчётом
    await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'агент, пусто').toBe(1);
    await expect(page.locator('header.top [data-testid="demo-badge"]')).toHaveText('Демо-данные');

    const input = page.getByLabel('Вопрос агенту');
    await input.fill('НДС по Альфе за февраль');
    if (width >= 760) await input.press('Enter');
    else await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.locator('.typing')).toHaveCount(0);
    const answer = page.locator('.msg:not(.me)').last();
    await expect(answer.locator('[data-testid="source-line"]')).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'агент, ответ').toBe(1);

    // окна под ответом: расчёт, проверка, передача
    for (const action of ['calc', 'check', 'send'] as const) {
      await answer.locator(`[data-action="${action}"]`).click();
      await expect(page.locator('[data-testid^="overlay-"]').first()).toBeVisible();
      expect(await count(page, 'Демо-данные'), `окно ${action}`).toBe(1);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid^="overlay-"]')).toHaveCount(0);
    }

    // дашборд: баннеры, карточки, окно расчёта
    await goTo(page, 'Дашборд');
    await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'дашборд').toBe(1);
    await page.locator('.sum-card').nth(1).click();
    await page.waitForTimeout(500);
    const detail = width >= 1024 ? page.locator('#sum-panel') : page.locator('.sum-item.open .acc');
    await detail.locator('[data-action="calc"]').click();
    await expect(page.getByTestId('overlay-drawer')).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'дашборд, расчёт').toBe(1);
    await page.keyboard.press('Escape');

    // документы
    await goTo(page, 'Документы');
    await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'документы').toBe(1);
    expect(await count(page, 'Образец, проверить юристом'), 'документы, образец').toBe(0);

    // статусы из меню
    await page.getByRole('button', { name: 'Меню' }).click();
    await page.getByRole('button', { name: 'Статусы проверок' }).click();
    await expect(page.getByRole('heading', { name: 'Статусы', level: 1 })).toBeVisible();
    expect(await count(page, 'Демо-данные'), 'статусы').toBe(1);
  });
}

test('В строке происхождения нет юрлица и периода, они в заголовке рядом', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  const lines = page.locator('[data-testid="source-line"]');
  const texts = await lines.allInnerTexts();
  // общая строка над баннерами, по одной в пяти карточках юрлиц, одна под графиком
  expect(texts).toHaveLength(1 + 5 + 1);
  for (const t of texts) {
    expect(t).toMatch(/^1С \(демо\) · обновлено \d{2}\.\d{2}, \d{2}:\d{2} · (факт|прогноз|факт и прогноз)$/);
  }
});
