import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { firstLogin, pickSuggestion, resetChat } from './helpers';

const PIN = '8246';

/** Снимки экрана для просмотра глазами; папка задаётся переменной, в обычном прогоне снимков нет. */
const SHOTS = process.env.FLEET_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const plain = (s: string) => s.replace(/[  ]/g, ' ');
const lastMsg = (page: Page) => page.locator('.msg:not(.me)').last();
const card = (page: Page) => page.locator('[data-form="fleet"]').last();

async function waitAnswer(page: Page): Promise<void> {
  await expect(page.locator('.typing')).toHaveCount(0);
}

/** Прогноз НДС за год на дашборде: статичное число, оно не должно меняться от сценария. */
async function forecastBanner(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  const value = page.locator('[data-tour="banner-vat-forecast"] .sum-value');
  await expect(value).toBeVisible();
  const text = plain(await value.innerText());
  await page.getByRole('link', { name: 'Агент' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
  return text;
}

test.describe('карточка «Что если купим N машин»: компьютер', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('подсказка открывает карточку, без полей не считает, «Изменить» открывает введённые значения', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await resetChat();
    await firstLogin(page, PIN);

    // плейсхолдер поля ввода показывает пример
    await expect(page.getByLabel('Вопрос агенту')).toHaveAttribute(
      'placeholder',
      'Например: что если купим 5 машин по 3 млн',
    );

    const forecastBefore = await forecastBanner(page);

    await pickSuggestion(page, 'Что если купим 5 машин?');
    await waitAnswer(page);
    const msg = lastMsg(page);
    await expect(msg).toContainText('Не хватает: юрлицо, стоимость машины, цена сдачи.');
    // ничего не посчитано: ни пометки сценария, ни таблицы, ни действий
    await expect(msg.getByTestId('scenario-mark')).toHaveCount(0);
    await expect(msg.locator('table')).toHaveCount(0);

    const form = card(page);
    await expect(form).toBeVisible();
    // юрлица кнопками, как раньше
    await expect(form.getByRole('radio')).toHaveText(['Альфа', 'Бета', 'Дельта', 'Гамма', 'Эпсилон', 'с НДС', 'без НДС']);
    // 5 машин подставлено из вопроса, 20 дней по умолчанию, следующий месяц выбран
    await expect(form.getByLabel('Сколько машин')).toHaveValue('5');
    await expect(form.getByLabel('Дней сдачи в месяц')).toHaveValue('20');
    await expect(form.getByLabel('С какого месяца сдаём')).toHaveValue('10');
    await expect(form.getByLabel('С какого месяца сдаём').locator('option')).toHaveText(['Ноябрь', 'Декабрь']);
    // быстрые варианты цены, пока значения не названы
    await expect(form.getByRole('group', { name: 'Быстрые варианты стоимости' }).getByRole('button')).toHaveText([
      '2 млн',
      '3 млн',
      '5 млн',
    ]);
    await expect(form.getByRole('group', { name: 'Быстрые варианты цены сдачи' }).getByRole('button')).toHaveText([
      '5 000 ₽',
      '8 000 ₽',
      '12 000 ₽',
    ]);

    // обязательные поля пусты: «Рассчитать» не работает, подсказка называет недостающее
    const go = form.getByRole('button', { name: 'Рассчитать', exact: true });
    await expect(go).toBeDisabled();
    await expect(form.getByTestId('ff-left')).toContainText('Выберите юрлицо');
    await expect(form.getByTestId('ff-left')).toContainText('Укажите стоимость машины');
    await expect(form.getByTestId('ff-left')).toContainText('Укажите цену сдачи');

    await form.getByRole('radio', { name: 'Дельта', exact: true }).click();
    await form.getByRole('button', { name: '3 млн', exact: true }).click();
    await expect(go).toBeDisabled();
    await form.getByRole('button', { name: '8 000 ₽', exact: true }).click();
    // итог считается ядром и виден до отправки: сумма покупки и выручка в месяц
    await expect(form.getByTestId('ff-live')).toHaveText('5 машин × 3 000 000 ₽ = 15 000 000 ₽, выручка 800 000 ₽ в месяц');
    await expect(form.getByLabel('Стоимость одной машины, ₽')).toHaveValue('3 000 000');
    await expect(go).toBeEnabled();
    await shot(page, 'desktop-card');

    await go.click();
    await waitAnswer(page);
    const answer = lastMsg(page);
    await expect(answer.getByTestId('scenario-mark')).toHaveText('Сценарий, а не прогноз:');
    expect(plain(await answer.innerText())).toContain(
      '5 машин по 3 000 000 ₽ с НДС, сдача 8 000 ₽ в сутки × 20 дней = 160 000 ₽ в месяц на машину, с ноября',
    );
    await expect(answer.locator('.understood')).toContainText('ИП Дельта');
    await expect(answer).toContainText('Вычета входного НДС по машинам нет');
    await expect(answer).toContainText('Окупаемость: 3 000 000 ₽ / 160 000 ₽ = 18,8 мес.');
    await expect(answer).toContainText('По сценарию дороже на');
    for (const name of ['Показать расчёт', 'Выгрузить в Excel', 'Проверить самому', 'Отправить на проверку']) {
      await expect(answer.getByTestId('actions').getByRole('button', { name, exact: true })).toBeVisible();
    }
    // старая карточка с вопросом осталась для чтения
    await expect(page.locator('[data-form="fleet"][data-mode="ask"] input:not([disabled])')).toHaveCount(0);

    // «Изменить» в карточке «Понял так» снова открывает поля с введёнными значениями
    await answer.getByRole('button', { name: 'Изменить', exact: true }).click();
    const edit = answer.locator('[data-form="fleet"]');
    await expect(edit).toBeVisible();
    await expect(edit.getByRole('radio', { name: 'Дельта', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(edit.getByLabel('Сколько машин')).toHaveValue('5');
    await expect(edit.getByLabel('Стоимость одной машины, ₽')).toHaveValue('3 000 000');
    await expect(edit.getByLabel('Цена сдачи, ₽ в сутки')).toHaveValue('8 000');
    await expect(edit.getByLabel('Дней сдачи в месяц')).toHaveValue('20');
    await expect(edit.getByLabel('С какого месяца сдаём')).toHaveValue('10');
    await edit.getByLabel('Цена сдачи, ₽ в сутки').fill('12000');
    await expect(edit.getByLabel('Цена сдачи, ₽ в сутки')).toHaveValue('12 000');
    await edit.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await waitAnswer(page);
    expect(plain(await lastMsg(page).innerText())).toContain('сдача 12 000 ₽ в сутки × 20 дней = 240 000 ₽ в месяц на машину');

    // сценарий не меняет цифры дашборда
    expect(await forecastBanner(page)).toBe(forecastBefore);
  });

  test('значения из вопроса подставляются, спрашивается только недостающее', async ({ page }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);
    const field = page.getByLabel('Вопрос агенту');
    await field.fill('купим 3 машины по 4 млн, сдавать по 9000 в сутки');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await waitAnswer(page);
    const form = card(page);
    await expect(form).toBeVisible();
    await expect(lastMsg(page)).toContainText('Не хватает: юрлицо.');
    await expect(form.getByLabel('Сколько машин')).toHaveValue('3');
    await expect(form.getByLabel('Стоимость одной машины, ₽')).toHaveValue('4 000 000');
    await expect(form.getByLabel('Цена сдачи, ₽ в сутки')).toHaveValue('9 000');
    // быстрые суммы подписаны «Быстро» и есть всегда, пока карточка не отправлена
    await expect(form.getByRole('group', { name: 'Быстрые варианты стоимости' }).getByText('Быстро', { exact: true })).toBeVisible();
    await expect(form.getByRole('group', { name: 'Быстрые варианты цены сдачи' })).toHaveCount(1);
    // «с НДС» стоит сразу (покупка у дилера), подтверждать не нужно
    await expect(form.getByRole('radio', { name: 'с НДС', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(form.getByRole('radio', { name: 'без НДС', exact: true })).toHaveAttribute('aria-checked', 'false');
    const go = form.getByRole('button', { name: 'Рассчитать', exact: true });
    await expect(go).toBeDisabled();
    await form.getByRole('radio', { name: 'Эпсилон', exact: true }).click();
    await expect(go).toBeEnabled();
    await form.getByRole('radio', { name: 'без НДС', exact: true }).click();
    await go.click();
    await waitAnswer(page);
    const t = plain(await lastMsg(page).innerText());
    expect(t).toContain('3 машины по 4 000 000 ₽ без НДС, сдача 9 000 ₽ в сутки × 20 дней = 180 000 ₽ в месяц на машину, с ноября');
    // Эпсилон на 22% с вычетами: вход по машинам принят к вычету
    expect(t).toContain('принят к вычету в ноябре');
    expect(t).toContain('этот эффект не учтён, нужен бухгалтер');
  });

  test('разные цены по машинам: строки на каждую, быстрые суммы в строку с курсором, копирование первой, ответ по каждой', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await resetChat();
    await firstLogin(page, PIN);
    await pickSuggestion(page, 'Что если купим 5 машин?');
    await waitAnswer(page);
    const form = card(page);
    await form.getByRole('radio', { name: 'Эпсилон', exact: true }).click();

    // по умолчанию все машины одинаковые: поля общие, строк по машинам нет
    const same = form.getByTestId('ff-same');
    await expect(same).toHaveAttribute('aria-checked', 'true');
    await expect(form.getByTestId('ff-units')).toHaveCount(0);
    await same.click();
    await expect(same).toHaveAttribute('aria-checked', 'false');
    await expect(form.locator('.ff-unit')).toHaveCount(5);
    await expect(form.getByLabel('Стоимость одной машины, ₽')).toHaveCount(0);
    // жёсткие сообщения называют поле и машину
    const go = form.getByRole('button', { name: 'Рассчитать', exact: true });
    await expect(go).toBeDisabled();
    await expect(form.getByTestId('ff-left')).toContainText('Укажите стоимость машины 1');
    await expect(form.getByTestId('ff-left')).toContainText('Укажите цену сдачи машины 1');
    await expect(form.getByTestId('ff-left')).toContainText('и ещё 7');
    // копировать нечего, пока первая машина пуста, и причина написана
    await expect(form.getByTestId('ff-copy-first')).toBeDisabled();
    await expect(form.getByText('Сначала заполните машину 1.')).toBeVisible();

    // быстрая сумма попадает в строку, где курсор (машина 1 по умолчанию)
    await form.getByLabel('Стоимость машины 1, ₽').focus();
    await form.getByTestId('ff-quick-cost').getByRole('button', { name: '3 млн', exact: true }).click();
    await form.getByLabel('Цена сдачи машины 1, ₽ в сутки').focus();
    await form.getByTestId('ff-quick-rent').getByRole('button', { name: '8 000 ₽', exact: true }).click();
    await expect(form.getByLabel('Стоимость машины 1, ₽')).toHaveValue('3 000 000');
    await expect(form.getByLabel('Цена сдачи машины 1, ₽ в сутки')).toHaveValue('8 000');
    await form.getByTestId('ff-copy-first').click();
    for (let i = 1; i <= 5; i++) {
      await expect(form.getByLabel(`Стоимость машины ${i}, ₽`)).toHaveValue('3 000 000');
      await expect(form.getByLabel(`Цена сдачи машины ${i}, ₽ в сутки`)).toHaveValue('8 000');
    }
    // машина 2 дороже: курсор в её строке, быстрые суммы идут туда
    await form.getByLabel('Стоимость машины 2, ₽').focus();
    await expect(form.getByTestId('ff-quick-cost')).toContainText('стоимость машины 2');
    await form.getByTestId('ff-quick-cost').getByRole('button', { name: '5 млн', exact: true }).click();
    await form.getByLabel('Цена сдачи машины 2, ₽ в сутки').focus();
    await form.getByTestId('ff-quick-rent').getByRole('button', { name: '12 000 ₽', exact: true }).click();
    await expect(form.getByLabel('Стоимость машины 2, ₽')).toHaveValue('5 000 000');
    await expect(form.getByLabel('Стоимость машины 1, ₽')).toHaveValue('3 000 000');
    await expect(form.getByLabel('Цена сдачи машины 2, ₽ в сутки')).toHaveValue('12 000');
    await expect(go).toBeEnabled();
    // итог по всем машинам считает ядро: 3+5+3+3+3 млн; (4 × 8 000 + 12 000) × 20 = 880 000 ₽
    await expect(form.getByTestId('ff-live')).toHaveText('Всего 5 машин: 17 000 000 ₽, выручка 880 000 ₽ в месяц');
    await expect(form.getByTestId('ff-warn')).toHaveCount(0);
    await shot(page, 'desktop-rows');

    // мягкое предупреждение не блокирует
    await form.getByLabel('Стоимость машины 5, ₽').fill('100000');
    await expect(form.getByTestId('ff-warn')).toContainText('Машина 5: стоимость 100 000 ₽ меньше 300 000 ₽, проверьте');
    await expect(go).toBeEnabled();
    await form.getByLabel('Стоимость машины 5, ₽').fill('3000000');
    await expect(form.getByTestId('ff-warn')).toHaveCount(0);

    // общий переключатель «с НДС» относится к покупке; цена сдачи с НДС, как платит клиент
    await expect(form.getByRole('radio', { name: 'с НДС', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(form.getByText('Цена, которую платит клиент, как есть', { exact: false }).first()).toBeVisible();

    await go.click();
    await waitAnswer(page);
    const answer = lastMsg(page);
    await expect(answer.getByTestId('scenario-mark')).toHaveText('Сценарий, а не прогноз:');
    const t = plain(await answer.innerText());
    expect(t).toContain('машина 2 за 5 000 000 ₽, сдача 12 000 ₽ в сутки (240 000 ₽ в месяц)');
    expect(t).toContain('принят к вычету в ноябре: у ООО «Эпсилон» ставка 22% с вычетами');
    expect(t).toContain('Окупаемость всех машин вместе');
    // таблица по машинам: пять строк и «Вместе»
    const perCar = answer.locator('table').filter({ hasText: 'Окупаемость' }).last();
    await expect(perCar.locator('tbody tr')).toHaveCount(6);
    await expect(perCar.locator('tbody tr').nth(1)).toContainText('5 000 000 ₽');
    await expect(perCar.locator('tbody tr').nth(1)).toContainText('240 000 ₽');
    await expect(perCar.locator('tbody tr').last()).toContainText('Вместе');

    // «Изменить» открывает те же строки; больше 10 машин: переключатель заблокирован с подсказкой
    await answer.getByRole('button', { name: 'Изменить', exact: true }).click();
    const edit = answer.locator('[data-form="fleet"]');
    await expect(edit.getByTestId('ff-same')).toHaveAttribute('aria-checked', 'false');
    await expect(edit.getByLabel('Стоимость машины 2, ₽')).toHaveValue('5 000 000');
    await edit.getByLabel('Сколько машин').fill('11');
    await expect(edit.getByTestId('ff-same')).toBeDisabled();
    await expect(edit.getByTestId('ff-same')).toHaveAttribute('aria-checked', 'true');
    await expect(edit.getByTestId('ff-many')).toContainText('до 10 машин');
    await expect(edit.getByLabel('Стоимость одной машины, ₽')).toBeVisible();
    await edit.getByLabel('Сколько машин').fill('0');
    await expect(edit.getByTestId('ff-left')).toContainText('Укажите, сколько машин: от 1 до 50');
    await expect(edit.getByRole('button', { name: 'Рассчитать', exact: true })).toBeDisabled();
  });
});

test.describe('карточка «Что если купим N машин»: телефон 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('поля числовые, 16 px, пробелы между тысячами; при открытой клавиатуре поля и «Рассчитать» не перекрыты', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await resetChat();
    await firstLogin(page, PIN);

    await pickSuggestion(page, 'Что если купим 5 машин?');
    await waitAnswer(page);
    const form = card(page);
    await expect(form).toBeVisible();
    await shot(page, 'phone-card-top');

    // числовые поля: inputmode numeric и шрифт не меньше 16 px (иначе iOS увеличит страницу)
    const specs = await form.locator('input[type="text"], select').evaluateAll((els) =>
      els.map((e) => ({
        id: (e as HTMLElement).id,
        mode: e.getAttribute('inputmode'),
        size: parseFloat(getComputedStyle(e).fontSize),
        tag: e.tagName,
      })),
    );
    expect(specs).toHaveLength(6);
    for (const s of specs) {
      expect(s.size, s.id).toBeGreaterThanOrEqual(16);
      if (s.tag === 'INPUT') expect(s.mode, s.id).toBe('numeric');
    }
    // и шрифт поля ввода чата тоже
    expect(await page.getByLabel('Вопрос агенту').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);

    // печать цифрами: пробелы между тысячами ставятся сами
    const cost = form.getByLabel('Стоимость одной машины, ₽');
    await cost.tap();
    await cost.pressSequentially('4500000');
    await expect(cost).toHaveValue('4 500 000');
    await cost.press('Backspace');
    await expect(cost).toHaveValue('450 000');
    await cost.fill('');
    await cost.pressSequentially('3000000');
    await expect(cost).toHaveValue('3 000 000');

    // поле ниже видимой части получает фокус до появления клавиатуры (как после нажатия на подсказку
    // «Далее» на iOS): когда вьюпорт уменьшится на 300 px, оно должно оказаться над клавиатурой
    const rentField = form.getByLabel('Цена сдачи, ₽ в сутки');
    await rentField.evaluate((e) => (e as HTMLInputElement).focus({ preventScroll: true }));
    await page.setViewportSize({ width: 390, height: 544 });
    await expect(page.locator('html[data-kb="open"]')).toHaveCount(1);
    await shot(page, 'phone-keyboard-open-rent');

    const visible = async (loc: ReturnType<Page['locator']>, label: string) => {
      await expect
        .poll(
          async () =>
            loc.evaluate((e) => {
              const r = e.getBoundingClientRect();
              const list = document.querySelector('.chat-scroll')!.getBoundingClientRect();
              const comp = document.querySelector('.composer-wrap')!.getBoundingClientRect();
              return r.top >= list.top - 0.5 && r.bottom <= Math.min(list.bottom, comp.top) + 0.5;
            }),
          { message: label, timeout: 4000 },
        )
        .toBe(true);
    };
    await visible(rentField, 'Цена сдачи');

    // клавиатура открыта: каждое следующее поле, взявшее фокус, тоже оказывается над ней. Список
    // сначала уводится в начало, чтобы поле было заведомо вне видимой части
    const box = page.locator('.chat-scroll');
    for (const label of ['Сколько машин', 'Стоимость одной машины, ₽', 'Дней сдачи в месяц']) {
      const input = form.getByLabel(label);
      await box.evaluate((e) => (e.scrollTop = e.scrollHeight));
      await input.evaluate((e) => (e as HTMLInputElement).focus({ preventScroll: true }));
      await visible(input, label);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(await input.getAttribute('id'));
      expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollTop])).toEqual([0, 0]);
    }
    const exp = form.getByLabel('Расходы на машину в месяц, ₽ (необязательно)');
    await box.evaluate((e) => (e.scrollTop = 0));
    await exp.evaluate((e) => (e as HTMLInputElement).focus({ preventScroll: true }));
    await visible(exp, 'расходы');
    const select = form.getByLabel('С какого месяца сдаём');
    await box.evaluate((e) => (e.scrollTop = 0));
    await select.evaluate((e) => (e as HTMLSelectElement).focus({ preventScroll: true }));
    await visible(select, 'месяц');
    // шапка и страница на месте
    expect(await page.evaluate(() => document.querySelector('header')!.getBoundingClientRect().top)).toBe(0);

    // заполняем и проверяем кнопку у клавиатуры
    await form.getByLabel('Цена сдачи, ₽ в сутки').tap();
    await form.getByLabel('Цена сдачи, ₽ в сутки').pressSequentially('8000');
    await form.getByRole('radio', { name: 'Дельта', exact: true }).tap();
    const go = form.getByRole('button', { name: 'Рассчитать', exact: true });
    await expect(go).toBeEnabled();
    await go.evaluate((e) => {
      // прокрутка списка до кнопки, как сделал бы палец
      const box = e.closest('.chat-scroll') as HTMLElement;
      box.scrollTop = box.scrollHeight;
    });
    await page.waitForTimeout(200);
    await shot(page, 'phone-keyboard-open-button-raw');
    await visible(go, 'Рассчитать');
    await shot(page, 'phone-keyboard-open-button');
    const gb = (await go.boundingBox())!;
    expect(gb.height).toBeGreaterThanOrEqual(44);

    await go.tap();
    await waitAnswer(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const answer = lastMsg(page);
    await expect(answer.getByTestId('scenario-mark')).toBeVisible();
    // страница на месте: шапка не уехала под часы
    expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollTop])).toEqual([0, 0]);
    await shot(page, 'phone-answer');
  });

  test('разные цены по машинам на телефоне: строки помещаются в 390 px, поля 16 px и не меньше 44 px высотой', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);
    await pickSuggestion(page, 'Что если купим 5 машин?');
    await waitAnswer(page);
    const form = card(page);
    await form.getByTestId('ff-same').tap();
    await expect(form.locator('.ff-unit')).toHaveCount(5);
    const geo = await form.evaluate((root) => {
      const box = root.getBoundingClientRect();
      const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.ff-unit input'));
      return {
        overflow: root.scrollWidth - root.clientWidth,
        right: Math.max(...inputs.map((i) => i.getBoundingClientRect().right)) - box.right,
        heights: inputs.map((i) => Math.round(i.getBoundingClientRect().height)),
        sizes: inputs.map((i) => parseFloat(getComputedStyle(i).fontSize)),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geo.overflow).toBeLessThanOrEqual(0);
    expect(geo.right).toBeLessThanOrEqual(0);
    expect(geo.pageOverflow).toBeLessThanOrEqual(0);
    for (const h of geo.heights) expect(h).toBeGreaterThanOrEqual(44);
    for (const sz of geo.sizes) expect(sz).toBeGreaterThanOrEqual(16);
    const sw = (await form.getByTestId('ff-same').boundingBox())!;
    expect(sw.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'phone-rows');
  });
});
