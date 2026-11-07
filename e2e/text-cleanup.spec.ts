import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, holdSession, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

async function sql(text: string): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

/**
 * Видимый текст страницы без скриптов и стилей, вместе со скрытым и свёрнутым (textContent), и
 * видимый глазом (innerText). Проверяем, что слово «демо» убрано из интерфейса.
 */
const demoCount = (page: Page) =>
  page.evaluate(() => {
    const walk = (root: Node): string => {
      let out = '';
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const tag = n.parentElement?.tagName;
          return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = w.nextNode(); n; n = w.nextNode()) out += `${n.nodeValue} `;
      return out;
    };
    const re = /демо/gi;
    return {
      text: (walk(document.body).match(re) ?? []).length,
      visible: ((document.body.innerText ?? '').match(re) ?? []).length,
      snippets: [...(document.body.innerText ?? '').matchAll(/демо/gi)].map((m) =>
        (document.body.innerText ?? '').slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40).replace(/\s+/g, ' '),
      ),
    };
  });

async function expectNoDemo(page: Page, label: string): Promise<void> {
  const c = await demoCount(page);
  expect(c.visible, `${label}: видимый текст: ${JSON.stringify(c.snippets)}`).toBe(0);
  expect(c.text, `${label}: весь текст страницы`).toBe(0);
}

async function goTo(page: Page, tab: 'Агент' | 'Дашборд' | 'Документы') {
  await page.getByRole('link', { name: tab, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${tab === 'Агент' ? 'agent' : tab === 'Дашборд' ? 'dashboard' : 'documents'}$`));
}

for (const width of [390, 1440]) {
  test(`Слово «демо» убрано из экранов и окон, ${width} px`, async ({ page }) => {
    test.setTimeout(240_000);
    await resetChat();
    await sql('delete from documents');
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await holdSession();

    // агент: пустой экран и после ответа с расчётом
    await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
    await expectNoDemo(page, 'агент, пусто');

    const input = page.getByLabel('Вопрос агенту');
    await input.fill('НДС по Альфе за февраль');
    if (width >= 760) await input.press('Enter');
    else await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.locator('.typing')).toHaveCount(0);
    // первый ответ: дальше в чате появятся и другие, поэтому берём именно его
    const answer = page.locator('.msg:not(.me)').first();
    await expect(answer.locator('[data-testid="source-line"]')).toBeVisible();
    await expect(answer.locator('[data-testid="source-line"]')).toHaveText(
      /^Выгрузка из 1С · обновлено \d{2}\.\d{2}, \d{2}:\d{2} · (факт|прогноз|факт и прогноз)$/,
    );
    await answer.locator('summary', { hasText: 'Как посчитано' }).click();
    await expectNoDemo(page, 'агент, ответ');

    // вопрос вне данных: «Данные есть …» без слова «демо»
    await input.fill('налог за 2024 год');
    if (width >= 760) await input.press('Enter');
    else await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.locator('.typing')).toHaveCount(0);
    await expectNoDemo(page, 'агент, ответ вне данных');

    // окна под ответом: расчёт, проверка, передача
    for (const action of ['calc', 'check', 'send'] as const) {
      await answer.locator(`[data-action="${action}"]`).click();
      await expect(page.locator('[data-testid^="overlay-"]').first()).toBeVisible();
      await expectNoDemo(page, `окно ${action}`);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid^="overlay-"]')).toHaveCount(0);
    }

    // окно «Отправить на проверку»: «Письмо не отправляется» только здесь, без слова «демо»
    await answer.locator('[data-action="send"]').click();
    const modal = page.getByTestId('overlay-modal');
    await expect(modal.getByTestId('demo-mail-note')).toContainText('Письмо не отправляется');
    await page.keyboard.press('Escape');

    // дашборд: баннеры, карточки, окно расчёта
    await goTo(page, 'Дашборд');
    await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
    await expectNoDemo(page, 'дашборд');
    await page.locator('.sum-card').nth(1).click();
    await page.waitForTimeout(500);
    const detail = width >= 1024 ? page.locator('#sum-panel') : page.locator('.sum-item.open .acc');
    await detail.locator('[data-action="calc"]').click();
    await expect(page.getByTestId('overlay-drawer')).toBeVisible();
    await expectNoDemo(page, 'дашборд, расчёт');
    await page.keyboard.press('Escape');

    // документы: каталог, лист с пропусками, меню, окна
    await goTo(page, 'Документы');
    await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
    await expectNoDemo(page, 'документы');
    expect(await page.evaluate(() => (document.body.innerText ?? '').includes('Образец, проверить юристом'))).toBe(false);

    await page.locator('[data-template="report_vat_certificate"] [data-action="fill"]').click();
    const start = page.getByRole('dialog', { name: /Заполнить:/ });
    await start.getByLabel('Вид периода').selectOption({ label: 'Месяц' });
    await start.getByRole('button', { name: 'Заполнить', exact: true }).click();
    await expect(page.getByTestId('sheet')).toBeVisible();
    await expectNoDemo(page, 'лист документа');
    // реквизиты в тексте без пометки «(демо)»
    expect(await page.getByTestId('sheet').innerText()).not.toMatch(/демо/i);

    await page.getByRole('button', { name: 'Ещё' }).click();
    await page.getByRole('menuitem', { name: 'Проверить самому' }).click();
    await expect(page.getByTestId('overlay-screen')).toBeVisible();
    await expectNoDemo(page, 'документ, проверить самому');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ещё' }).click();
    await page.getByRole('menuitem', { name: 'История версий' }).click();
    await expectNoDemo(page, 'документ, история');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ещё' }).click();
    await page.getByRole('menuitem', { name: /Комментарии/ }).click();
    await expectNoDemo(page, 'документ, комментарии');
    await page.keyboard.press('Escape');

    // отправка и имитация ответа: подписи без слова «демо»
    await page.locator('[data-action="complete"]').click();
    const form = page.getByTestId('overlay-screen');
    await form.getByLabel(/Подготовил/).fill('Образцов О.И.');
    await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();
    await page.locator('[data-action="submit"]').click();
    const send = page.getByTestId('overlay-modal');
    await expect(send.getByTestId('demo-mail-note')).toHaveText('Письмо не отправляется');
    await expectNoDemo(page, 'документ, окно отправки');
    await send.getByRole('radio', { name: /Бухгалтер/ }).check();
    await send.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.getByTestId('demo-reply')).toBeVisible();
    await expectNoDemo(page, 'документ на проверке, имитация ответа');
    await page.getByTestId('demo-reply').getByRole('button', { name: 'Замечание' }).click();
    await expectNoDemo(page, 'документ, замечание');
    await page.getByRole('button', { name: 'Ещё' }).click();
    await page.getByRole('menuitem', { name: /Комментарии/ }).click();
    await expect(page.getByTestId('comments')).toContainText('имитация');
    await expectNoDemo(page, 'документ, комментарии после ответа');
    await page.keyboard.press('Escape');

    // статусы из меню: подписи «Письмо не отправляется» здесь нет
    await page.getByRole('button', { name: 'Меню' }).click();
    await page.getByRole('button', { name: 'Что проверено' }).click();
    await expect(page.getByRole('heading', { name: 'Что проверено', level: 1 })).toBeVisible();
    await expectNoDemo(page, 'статусы');
    expect(await page.evaluate(() => (document.body.innerText ?? '').includes('Письмо не отправляется'))).toBe(false);

    await sql('delete from documents');
  });
}

test('В строке происхождения нет юрлица и периода, они в заголовке рядом; источник «Выгрузка из 1С»', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  const lines = page.locator('[data-testid="source-line"]');
  const texts = await lines.allInnerTexts();
  // общая строка над баннерами, по одной в пяти карточках юрлиц, одна под графиком
  expect(texts).toHaveLength(1 + 5 + 1);
  for (const t of texts) {
    expect(t).toMatch(/^Выгрузка из 1С · обновлено \d{2}\.\d{2}, \d{2}:\d{2} · (факт|прогноз|факт и прогноз)$/);
  }
});

test('График: подписи с пояснением как пользоваться нет, подпись выбранного появляется после выбора', async ({ page }) => {
  await resetChat();
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  const chart = page.locator('.chart');
  await expect(chart).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('Наведите или нажмите на сегмент');
  expect(text).not.toContain('Нажмите на подпись месяца');
  // постоянной плашки нет: область подписи пуста и не занимает места
  const idle = await page.locator('.seg-card').boundingBox();
  expect(idle === null || idle.height < 2).toBe(true);
  // после выбора появляется подпись с юрлицом, месяцем и суммой
  await page.locator('.mon button').nth(3).click();
  await expect(page.locator('.seg-card')).toContainText('весь столбец');
  const shown = await page.locator('.seg-card').boundingBox();
  expect(shown!.height).toBeGreaterThan(40);
  // повторное нажатие снимает выбор, плашка снова исчезает (мышь уводим: наведение на подпись месяца тоже выбирает)
  await page.locator('.mon button').nth(3).click();
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await page.locator('.seg-card').boundingBox())?.height ?? 0).toBeLessThan(2);
});
