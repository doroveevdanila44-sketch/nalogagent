import { expect, test, type Page } from '@playwright/test';
import { firstLogin, pickSuggestion, resetChat } from './helpers';

const PIN = '8246';

/** Последний ответ агента. */
const lastAnswer = (page: Page) => page.locator('.msg:not(.me)').last();

/** Свободный ввод: текст в поле и Enter (на компьютере) или кнопка «Отправить» (телефон). */
async function typeAndSend(page: Page, text: string): Promise<void> {
  const field = page.getByLabel('Вопрос агенту');
  await field.fill(text);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
}

/** Прогноз НДС за год на дашборде: статичное число, живые баннеры тикают, его тики не меняют. */
async function forecastBanner(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  const value = page.locator('[data-tour="banner-vat-forecast"] .sum-value');
  await expect(value).toBeVisible();
  const text = (await value.innerText()).replace(/[  ]/g, ' ');
  await page.getByRole('link', { name: 'Агент' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
  return text;
}

test('«Что если»: подсказки первыми и янтарные, вопрос про юрлицо, ответ с пометкой, допущениями и таблицей, действия', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetChat();
  await firstLogin(page, PIN);

  // пустой чат на компьютере: подсказки по центру, две «Что если» первыми и янтарные
  const chips = page.locator('.chat-empty .sug button');
  await expect(chips).toHaveCount(6);
  await expect(chips.nth(0)).toHaveText('Что если купим 5 машин?');
  await expect(chips.nth(1)).toHaveText('Что если выручка вырастет на 20%?');
  const bg = await chips.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  expect(bg.slice(0, 2)).toEqual(['rgb(255, 230, 168)', 'rgb(255, 230, 168)']);
  expect(new Set(bg.slice(2))).toEqual(new Set(['rgb(120, 66, 68)']));

  const forecastBefore = await forecastBanner(page);

  // карточка с полями вместо молчаливых допущений: юрлицо, стоимость и цена сдачи спрашиваются
  await pickSuggestion(page, 'Что если купим 5 машин?');
  await expect(page.locator('.typing')).toHaveCount(0);
  const ask = lastAnswer(page);
  await expect(ask).toContainText('Не хватает: юрлицо, стоимость машины, цена сдачи.');
  const form = ask.locator('[data-form="fleet"]');
  await expect(form.getByRole('radio', { name: /^(Альфа|Бета|Дельта|Гамма|Эпсилон)$/ })).toHaveCount(5);
  await expect(form.getByRole('button', { name: 'Рассчитать', exact: true })).toBeDisabled();
  await form.getByRole('radio', { name: 'Дельта', exact: true }).click();
  await form.getByRole('button', { name: '3 млн', exact: true }).click();
  await form.getByRole('button', { name: '8 000 ₽', exact: true }).click();
  await form.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  const answer = lastAnswer(page);
  await expect(answer.getByTestId('scenario-mark')).toHaveText('Сценарий, а не прогноз:');
  await expect(answer.locator('.understood')).toContainText('ИП Дельта');
  await expect(answer.locator('.understood')).toContainText('+5 машин');
  // допущения видны в самом ответе, не в раскрывающемся блоке
  const assumptions = answer.locator('.msg-list li');
  await expect(assumptions.first()).toContainText('цена сдачи 8');
  await expect(answer).not.toContainText('демо-значение');
  await expect(answer).toContainText('Признаки единого бизнеса');
  await expect(answer).toContainText('порог 20 млн пересекается');
  await expect(answer).toContainText('По сценарию дороже на');

  // таблица «сейчас и по сценарию»
  const table = answer.locator('table').first();
  await expect(table.locator('thead th')).toHaveText(['За год', 'Сейчас', 'По сценарию', 'Разница']);
  await expect(table.locator('tbody tr').first()).toContainText('Выручка');

  // те же действия, что у остальных расчётов
  const actions = answer.getByTestId('actions');
  for (const name of ['Показать расчёт', 'Выгрузить в Excel', 'Проверить самому', 'Отправить на проверку']) {
    await expect(actions.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(answer.getByRole('button', { name: 'Сформировать документ' })).toHaveCount(0);

  // «Показать расчёт»: сверху «Сейчас и по сценарию», ниже расчёты «сейчас» и «по сценарию»
  await actions.getByRole('button', { name: 'Показать расчёт', exact: true }).click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer.getByTestId('calc-whatif')).toBeVisible();
  await expect(drawer.getByTestId('calc-whatif')).toContainText('Сейчас и по сценарию');
  await expect(drawer.getByTestId('calc-whatif')).toContainText('Сценарий, а не прогноз');
  const tabs = drawer.getByRole('tab');
  await expect(tabs.filter({ hasText: 'сейчас' })).not.toHaveCount(0);
  await expect(tabs.filter({ hasText: 'по сценарию' })).not.toHaveCount(0);
  await drawer.getByRole('button', { name: 'Закрыть' }).first().click();
  await expect(drawer).toHaveCount(0);

  // Excel: файл с листом «Сценарий»
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    actions.getByRole('button', { name: 'Выгрузить в Excel', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  // сценарий данные не меняет: прогноз НДС за год на дашборде тот же
  expect(await forecastBanner(page)).toBe(forecastBefore);
});

test('«Что если выручка вырастет на 20%?»: по группе считает всех, по Эпсилон налог на прибыль, свободный ввод', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await resetChat();
  await firstLogin(page, PIN);

  await pickSuggestion(page, 'Что если выручка вырастет на 20%?');
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(lastAnswer(page)).toContainText('Для какого юрлица?');
  await expect(lastAnswer(page).locator('.qreply')).toHaveText(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон']);

  await typeAndSend(page, 'по группе');
  const group = lastAnswer(page);
  await expect(group.locator('.understood')).toContainText('Вся группа');
  await expect(group.locator('.understood')).toContainText('+20% к выручке');
  await expect(group).toContainText('Налог на прибыль и УСН за год');
  await expect(group.locator('table')).toHaveCount(2);
  await expect(group.locator('table').nth(1).locator('tbody tr')).toHaveCount(6);

  // свободный ввод по юрлицу и по числу машин
  await typeAndSend(page, 'что если Дельта вырастет на 3 млн');
  await expect(lastAnswer(page)).toContainText('НДС начнётся с 1 декабря');

  // машины без стоимости и цены сдачи не считаются: юрлицо и число машин взяты из прежнего вопроса,
  // остальное спрашивает карточка
  await typeAndSend(page, 'а если купим 3 машины');
  await expect(lastAnswer(page)).toContainText('Не хватает: стоимость машины, цена сдачи.');
  const cars = lastAnswer(page).locator('[data-form="fleet"]');
  await expect(cars.getByLabel('Сколько машин')).toHaveValue('3');
  await expect(cars.getByRole('radio', { name: 'Дельта', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(lastAnswer(page).locator('.understood')).toHaveCount(0);

  await typeAndSend(page, 'а если выручка упадёт на 10% у Эпсилон');
  const eps = lastAnswer(page);
  await expect(eps).toContainText('Налог на прибыль за год');
  await expect(eps).toContainText('По сценарию выгоднее на');
});

test('Телефон 390: в пустом чате панель открыта, ответ-сценарий и таблица без горизонтальной прокрутки', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await resetChat();
  await firstLogin(page, PIN);

  const handle = page.locator('.sug-handle');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#chat-suggestions .sug button').first()).toHaveText('Что если купим 5 машин?');
  await expect(page.locator('#chat-suggestions .sug button').first()).toBeVisible();

  await pickSuggestion(page, 'Что если выручка вырастет на 20%?');
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await lastAnswer(page).getByRole('button', { name: 'Бета', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);

  const answer = lastAnswer(page);
  await expect(answer.getByTestId('scenario-mark')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    tables: [...document.querySelectorAll('.msg:not(.me) .tscroll')].map((e) => e.scrollWidth - e.clientWidth),
  }));
  expect(overflow.page).toBeLessThanOrEqual(0);
  for (const w of overflow.tables) expect(w).toBeLessThanOrEqual(1);
  // колонка названий строк не дробится по слову: «НДС» в одной строке
  const row = answer.locator('tbody tr', { hasText: 'НДС' }).first();
  expect((await row.locator('th, td').first().boundingBox())!.height).toBeLessThan(40);
});

test('Телефон 390: таблица «Юрлицо и режим»: название одной строкой, режим мелким серым текстом, без прокрутки', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetChat();
  await firstLogin(page, PIN);
  await pickSuggestion(page, 'Налог на прибыль за год?');
  await expect(page.locator('.typing')).toHaveCount(0);
  const table = lastAnswer(page).locator('.tscroll');
  await expect(table).toBeVisible();
  const m = await table.evaluate((el) => ({
    scroll: el.scrollWidth - el.clientWidth,
    names: [...el.querySelectorAll('.t-name')].map((e) => ({
      text: e.textContent,
      lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || '18')),
    })),
    sub: [...el.querySelectorAll('.t-sub')].map((e) => ({
      color: getComputedStyle(e).color,
      size: getComputedStyle(e).fontSize,
      height: e.getBoundingClientRect().height,
    })),
  }));
  expect(m.scroll).toBeLessThanOrEqual(1);
  expect(m.names.length).toBeGreaterThanOrEqual(5);
  for (const n of m.names) expect(n.lines, n.text ?? '').toBe(1);
  // режим мелким серым текстом: не больше трёх строк по 16 px
  for (const s of m.sub) {
    expect(s.size).toBe('12px');
    expect(s.color).toBe('rgb(107, 106, 82)'); // #6B6A52
    expect(s.height).toBeLessThanOrEqual(48);
  }
});
