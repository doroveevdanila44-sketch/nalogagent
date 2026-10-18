import { expect, test, type Page } from '@playwright/test';
import { firstLogin, pickSuggestion, resetChat } from './helpers';

const PIN = '8246';

const messages = (page: Page) => page.locator('.chat .msg');
const history = (page: Page) =>
  page.evaluate(async () => ((await (await fetch('/api/chat', { credentials: 'same-origin' })).json()) as { messages: unknown[] }).messages.length);

async function ask(page: Page, text: string): Promise<void> {
  const field = page.getByLabel('Вопрос агенту');
  await field.fill(text);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
}

test.describe('Очистить чат: компьютер', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('кнопка видна, только когда есть сообщения; отмена ничего не стирает; подтверждение очищает чат и базу', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);

    // пустой чат: очищать нечего
    await expect(page.getByTestId('chat-clear')).toHaveCount(0);

    await pickSuggestion(page, 'Какая ставка выгоднее?');
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(messages(page)).not.toHaveCount(0);
    const clear = page.getByTestId('chat-clear');
    await expect(clear).toBeVisible();
    await expect(clear).toHaveText('Очистить');
    await expect(clear).toHaveAccessibleName('Очистить чат');

    // отмена: окно закрылось, сообщения на месте
    const before = await messages(page).count();
    await clear.click();
    const dialog = page.getByRole('dialog', { name: 'Очистить чат?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('clear-chat-text')).toContainText('без возможности восстановления');
    await expect(dialog.getByTestId('clear-chat-text')).toContainText('Документы, запросы на проверку и отметки «сверил» останутся');
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(messages(page)).toHaveCount(before);
    expect(await history(page)).toBeGreaterThan(0);

    // Escape тоже закрывает окно без очистки
    await clear.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(messages(page)).toHaveCount(before);

    // подтверждение: чат пуст, подсказки на месте, в базе ничего нет
    await clear.click();
    await dialog.getByRole('button', { name: 'Очистить', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(messages(page)).toHaveCount(0);
    await expect(page.getByTestId('chat-clear')).toHaveCount(0);
    await expect(page.locator('.chat-empty .sug button')).toHaveCount(6);
    expect(await history(page)).toBe(0);

    // чат работает дальше, прежний вопрос забыт
    await ask(page, 'Сколько платить за квартал?');
    await expect(messages(page).last()).toBeVisible();
    await expect(page.getByTestId('chat-clear')).toBeVisible();
  });

  test('после очистки короткий ответ не продолжает забытый вопрос', async ({ page }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);
    await ask(page, 'сколько НДС платить');
    await expect(page.locator('.msg:not(.me)').last()).toContainText('какой период');
    await page.getByTestId('chat-clear').click();
    await page.getByRole('dialog', { name: 'Очистить чат?' }).getByRole('button', { name: 'Очистить', exact: true }).click();
    await expect(messages(page)).toHaveCount(0);
    await ask(page, 'февраль');
    // без прежнего вопроса «февраль» остаётся непонятным и расчёта нет
    await expect(page.locator('.msg:not(.me)').last()).not.toContainText('Понял так');
  });
});

test.describe('Очистить чат: телефон 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('кнопка в ряду «Подсказки», область нажатия не меньше 36 px, очистка работает', async ({ page }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);
    await pickSuggestion(page, 'Что с порогами?');
    await expect(page.locator('.typing')).toHaveCount(0);

    const clear = page.getByTestId('chat-clear');
    await expect(clear).toBeVisible();
    const box = (await clear.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // ручка «Подсказки» осталась по центру и не перекрыта кнопкой
    const handle = (await page.locator('.sug-handle').boundingBox())!;
    expect(handle.height).toBe(28);
    expect(Math.abs(handle.x + handle.width / 2 - 195)).toBeLessThan(2);
    const label = (await page.locator('.sug-handle').evaluate((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      const b = r.getBoundingClientRect();
      return { left: b.left, right: b.right };
    }));
    expect(label.right).toBeLessThan(box.x);

    await clear.tap();
    const dialog = page.getByRole('dialog', { name: 'Очистить чат?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Очистить', exact: true }).tap();
    await expect(messages(page)).toHaveCount(0);
    // в пустом чате на телефоне панель подсказок открыта по умолчанию
    await expect(page.locator('.sug-handle')).toHaveAttribute('aria-expanded', 'true');
    expect(await history(page)).toBe(0);
  });
});
