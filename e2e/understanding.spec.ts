import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

/** Агент отвечает без модели, поэтому текст ответа и карточку можно проверять буквально. */
async function ask(page: Page, text: string) {
  const input = page.getByLabel('Вопрос агенту');
  await expect(page.locator('.typing')).toHaveCount(0);
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
}

const last = (page: Page) => page.locator('.msg:not(.me)').last();

test('Понимание: карточка «Понял так», «Изменить», уточнение с кнопками, пояснение', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);

  // 1. карточка перед результатом; период февраль, не год
  await ask(page, 'расчёт за февраль');
  const answer = last(page);
  await expect(answer.locator('.understood')).toContainText(/Понял так: Вся группа, НДС, февраль \d{4} \(факт\)/);
  await expect(answer.locator('.understood .u-notes')).toContainText('налог не назван, считаю НДС');
  await expect(answer).toContainText(/НДС за февраль \d{4} по группе/);
  await expect(answer).not.toContainText('за год');
  await expect(answer.locator('table').first()).toBeVisible();
  // карточка идёт первой в сообщении
  expect(await answer.evaluate((e) => (e.firstElementChild as HTMLElement).className)).toBe('understood');

  // 2. Группа не названа: сказано прямо и есть кнопки сужения
  await expect(answer).toContainText('посчитал по всей группе');
  await expect(answer.getByRole('button', { name: 'Бета', exact: true })).toBeVisible();

  // 3. «Изменить»: варианты юрлица, налога и периода; выбор пересчитывает прежний вопрос
  const edit = answer.getByRole('button', { name: 'Изменить' });
  await expect(edit).toHaveAttribute('aria-expanded', 'false');
  await edit.click();
  await expect(edit).toHaveAttribute('aria-expanded', 'true');
  await expect(answer.locator('.u-panel')).toBeVisible();
  await answer.locator('.u-panel').getByRole('button', { name: 'УСН', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(last(page).locator('.understood')).toContainText(/Понял так: Вся группа, УСН, февраль \d{4} \(факт\)/);
  await expect(last(page)).toContainText(/Налог по УСН за февраль \d{4} по группе/);

  // 4. один короткий вопрос, ответ кнопкой, затем второй, ответ кнопкой
  await ask(page, 'сколько платить');
  await expect(last(page)).toContainText('Какой налог и за какой период посчитать?');
  await last(page).getByRole('button', { name: 'НДС', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(last(page)).toContainText('За какой период посчитать НДС?');
  await last(page).getByRole('button', { name: 'С начала года' }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(last(page).locator('.understood')).toContainText('с начала года');
  await expect(last(page).locator('.understood')).toContainText('(факт и прогноз)');

  // 5. ответ текстом тоже склеивается с прежним вопросом
  await ask(page, 'сколько НДС платить');
  await expect(last(page)).toContainText('За какой период посчитать НДС?');
  await ask(page, 'февраль');
  await expect(last(page).locator('.understood')).toContainText(/НДС, февраль \d{4}/);

  // 6. пояснение вместо общего отказа
  await ask(page, 'налог за 2027');
  await expect(last(page)).toContainText('Лимиты 2027 пока не утверждены, жду дефлятор');
  await expect(last(page)).toContainText('Что могу сейчас:');
  await expect(last(page).locator('.understood')).toHaveCount(0);
});

test('Понимание: доступность и телефон', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 390, height: 844 });

  await ask(page, 'НДС по Альфе за 2 квартал');
  await last(page).getByRole('button', { name: 'Изменить' }).click();
  await expect(last(page).locator('.u-panel')).toBeVisible();

  // нет горизонтальной прокрутки у списка и у сообщения
  const overflow = await page.evaluate(() => {
    const list = document.querySelector('.chat-scroll') as HTMLElement;
    const msg = [...document.querySelectorAll('.msg:not(.me)')].at(-1) as HTMLElement;
    return { list: list.scrollWidth > list.clientWidth + 1, msg: msg.scrollWidth > msg.clientWidth + 1 };
  });
  expect(overflow).toEqual({ list: false, msg: false });

  // кнопки не меньше 36 px, как у подсказок над полем
  const heights = await last(page)
    .locator('.qreply')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);

  // нажатие на кнопку не снимает фокус с поля: клавиатура остаётся
  const input = page.getByLabel('Вопрос агенту');
  await input.focus();
  await last(page).locator('.u-panel').getByRole('button', { name: 'Налог на прибыль', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');

  // контраст и имена кнопок
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('.wordmark')
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('; ')}`)).toEqual([]);
});
