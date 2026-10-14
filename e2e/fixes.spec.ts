import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, holdSession, pickSuggestion, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

test.beforeEach(async () => {
  await sql('delete from documents');
  await resetChat();
});
test.afterAll(async () => {
  await sql('delete from documents');
});

const luminance = (rgb: string): number => {
  const [r, g, b] = (rgb.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Окно «Сформировать документ» под расчётом в чате: вторая строка кнопок читается (контраст не ниже 4,5:1). */
test('«Сформировать документ»: вторая строка кнопок («Договоры · .docx») читается, контраст не ниже 4,5:1', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await pickSuggestion(page, 'Сколько платить за квартал?');
  await expect(page.locator('.typing')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сформировать документ' }).last().click();
  const modal = page.getByRole('dialog', { name: 'Сформировать документ' });
  const pick = modal.locator('.act.pick').first();
  await expect(pick).toBeVisible();
  await expect(pick.locator('small')).toContainText('.docx');
  const read = async () =>
    pick.evaluate((b) => {
      const s = b.querySelector('small')!;
      return { fg: getComputedStyle(s).color, bg: getComputedStyle(b).backgroundColor };
    });
  const normal = await read();
  expect(contrast(normal.fg, normal.bg)).toBeGreaterThanOrEqual(4.5);
  // в нажатом и наведённом виде фон светлее на тон: контраст тоже не ниже
  await pick.hover();
  const hover = await read();
  expect(contrast(hover.fg, hover.bg)).toBeGreaterThanOrEqual(4.5);
});

test('«Заполнить»: юрлицо по виду деятельности и мягкое предупреждение, создать документ можно', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await holdSession();
  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await page.getByRole('tab', { name: 'Каталог шаблонов' }).click();

  // договор с экипажем и трансфером: по умолчанию Гамма, предупреждения нет
  await page.locator('[data-template="contract_rent_with_crew"] [data-action="fill"]').click();
  const dialog = page.getByRole('dialog', { name: /Заполнить:/ });
  const select = dialog.getByLabel('Юрлицо', { exact: true });
  await expect(select.locator('option:checked')).toHaveText('ООО «Гамма»');
  await expect(dialog.getByTestId('template-warning')).toHaveCount(0);

  // выбрано юрлицо без экипажа: «Обычно этот шаблон используется для «Гамма». Продолжить можно»
  await select.selectOption({ label: 'ООО «Альфа»' });
  await expect(dialog.getByTestId('template-warning')).toHaveText(
    'Обычно этот шаблон используется для «Гамма». Продолжить можно',
  );
  // предупреждение не блокирует
  await expect(dialog.getByRole('button', { name: 'Заполнить', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  // договор без экипажа: по умолчанию юрлицо без экипажа; Гамма даёт предупреждение со списком
  await page.locator('[data-template="contract_rent_no_crew"] [data-action="fill"]').click();
  const dialog2 = page.getByRole('dialog', { name: /Заполнить:/ });
  const select2 = dialog2.getByLabel('Юрлицо', { exact: true });
  await expect(select2.locator('option:checked')).toHaveText('ООО «Альфа»');
  await expect(dialog2.getByTestId('template-warning')).toHaveCount(0);
  await select2.selectOption({ label: 'ООО «Гамма»' });
  await expect(dialog2.getByTestId('template-warning')).toHaveText(
    'Обычно этот шаблон используется для «Альфа», «Бета», «Дельта». Продолжить можно',
  );
  // создать можно: документ открывается
  await dialog2.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
});

test('Удаление черновика: текст окна, уведомление над панелью, закрывается при смене экрана, реквизиты без заглушек', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await holdSession();
  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await page.getByRole('tab', { name: 'Каталог шаблонов' }).click();
  await page.locator('[data-template="contract_rent_no_crew"] [data-action="fill"]').click();
  await page.getByRole('dialog', { name: /Заполнить:/ }).getByRole('button', { name: 'Заполнить', exact: true }).click();
  const sheet = page.getByTestId('sheet');
  await expect(sheet).toBeVisible();
  // в договоре нет заглушек: подписант, адрес и банк правдоподобные
  const text = (await sheet.innerText()).replace(/[  ]/g, ' ');
  for (const bad of ['Типовой', 'Образцовая', 'Банк «Образец»', 'Образцов']) expect(text).not.toContain(bad);
  expect(text).toContain('Банк «Авачинский»');

  // меню «ещё» страницы документа: «Удалить», окно с текстом про 6 секунд
  await page.getByRole('button', { name: /ещё|Ещё/ }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить черновик?' });
  await expect(dialog).toContainText('Черновик будет удалён. Отменить можно в течение 6 секунд');
  await expect(dialog).not.toContainText('Восстановить нельзя');
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();

  // после удаления страница уходит в список, уведомление ждёт его, а не закрывается сразу
  await expect.poll(() => new URL(page.url()).pathname).toBe('/documents');
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Черновик удалён');
  await expect(toast.getByRole('button', { name: 'Отменить' })).toBeVisible();
  // над нижней панелью вкладок: не перекрывает её
  const geo = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="toast"]')!.getBoundingClientRect();
    const nav = document.querySelector('nav.tabs')!.getBoundingClientRect();
    return { toastBottom: t.bottom, navTop: nav.top };
  });
  expect(geo.toastBottom).toBeLessThanOrEqual(geo.navTop);

  // смена экрана закрывает уведомление (при удалённом документе открываем каталог другого раздела)
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(toast).toHaveCount(0);
});

test('Время и даты: «Сверено» с поясом «(Камчатка)», даты норм 01.01.2026, подпись карточки УСН', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await holdSession();

  // карточка УСН на дашборде
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await expect(page.locator('.ent').first()).toContainText('Прогноз года: доходы без НДС');
  await expect(page.locator('.ent').first()).not.toContainText(/(?<!: )Доходы без НДС \d/);

  // «Проверить самому» под расчётом в чате
  await page.getByRole('link', { name: 'Агент' }).click();
  await pickSuggestion(page, 'Что с порогами?');
  await pickSuggestion(page, 'Сколько платить за квартал?');
  await expect(page.locator('.typing')).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить самому' }).last().click();
  const screen = page.getByTestId('overlay-screen');
  await expect(screen).toBeVisible();
  // даты норм: 01.01.2026 по 31.12.2026
  const rules = screen.locator('.rule-list').first();
  await expect(rules).toContainText(/действует с \d{2}\.\d{2}\.\d{4}/);
  await expect(rules).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  // отметка «сверил»: время с подписью пояса
  await screen.locator('input[type="checkbox"]').first().check();
  const meta = screen.locator('.chk-meta').first();
  await expect(meta).toContainText('Сверено');
  await expect(meta).toContainText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(Камчатка\)/);
});

for (const width of [360, 390]) {
  test(`Полоса над шапкой на ${width} px с вырезом 47 px: шапка, html и body одного цвета, на входе и PIN бордо`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    const paint = () =>
      page.evaluate((w) => {
        const color = (el: Element | null) => {
          for (let e = el; e; e = e.parentElement) {
            const bg = getComputedStyle(e).backgroundColor;
            if (bg !== 'rgba(0, 0, 0, 0)') return bg;
          }
          return 'none';
        };
        const header = document.querySelector('header.top');
        return {
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
          header: header ? getComputedStyle(header).backgroundColor : null,
          headerPad: header ? getComputedStyle(header).paddingTop : null,
          top: color(document.elementFromPoint(w / 2, 4)),
          theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
        };
      }, width);
    const LAKE = 'rgb(160, 210, 168)';
    const WINE = 'rgb(120, 66, 68)';

    // вход: бордо целиком, theme-color бордо
    await page.goto('/login');
    await expect(page.locator('.auth-screen')).toBeVisible();
    expect(await paint()).toMatchObject({ html: WINE, body: WINE, top: WINE, theme: '#784244' });

    // приложение: цвет шапки под вырезом и за краем оболочки, theme-color озеро
    await firstLogin(page, PIN);
    await expect.poll(async () => (await paint()).header).toBe(LAKE);
    expect(await paint()).toMatchObject({
      html: LAKE,
      body: LAKE,
      header: LAKE,
      headerPad: '47px',
      top: LAKE,
      theme: '#A0D2A8',
    });

  });
}
