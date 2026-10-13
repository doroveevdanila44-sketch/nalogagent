import { devices, expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, holdSession, resetChat } from './helpers';

const PIN = '8246';

/**
 * Оболочка приложения: шапка и нижняя панель стоят на месте при прокрутке, прокручивается только
 * main. Эмуляция iPhone: размер и касание iPhone 14, движок тот же, что у остальных тестов (Chrome).
 * Настоящий WebKit Playwright на этой macOS не поддерживает; на машине, где он есть, проект
 * `webkit-iphone` (PW_WEBKIT=1) прогоняет эти же тесты на нём.
 */
const { defaultBrowserType: _browser, ...IPHONE } = devices['iPhone 14'];
test.use({ ...IPHONE });
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);

/** Прокручивает единственную прокручиваемую область и возвращает, насколько она сдвинулась. */
async function scrollMain(page: Page, top: number): Promise<number> {
  return page.evaluate((t) => {
    const main = document.querySelector<HTMLElement>('main.app-main')!;
    main.scrollTop = t;
    return main.scrollTop;
  }, top);
}

const pageState = (page: Page) =>
  page.evaluate(() => ({
    winY: window.scrollY,
    docTop: document.documentElement.scrollTop,
    bodyTop: document.body.scrollTop,
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    bodyOverflow: getComputedStyle(document.body).overflow,
    header: getComputedStyle(document.querySelector('header.top')!).position,
    tabs: getComputedStyle(document.querySelector('nav.tabs')!).position,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflowX: (() => {
      const m = document.querySelector<HTMLElement>('main.app-main')!;
      return m.scrollWidth - m.clientWidth;
    })(),
  }));

/** Экран прокручивается, а шапка и нижняя панель не двигаются ни на пиксель. */
async function expectShellStill(page: Page, label: string, opts: { tabs: boolean }): Promise<void> {
  const header0 = await boxOf(page, 'header.top');
  const tabs0 = opts.tabs ? await boxOf(page, 'nav.tabs') : null;
  expect(header0, `${label}: шапка есть`).not.toBeNull();
  if (opts.tabs) expect(tabs0, `${label}: нижняя панель есть`).not.toBeNull();
  const before = await pageState(page);
  expect(before.htmlOverflow, label).toBe('hidden');
  expect(before.bodyOverflow, label).toBe('hidden');
  // не fixed и не sticky относительно страницы: обычные элементы колонки
  expect(before.header, label).not.toMatch(/fixed|sticky/);
  expect(before.tabs, label).not.toMatch(/fixed|sticky/);
  expect(header0!.y, `${label}: шапка у самого верха`).toBeLessThanOrEqual(0.5);
  if (tabs0) {
    // низ нижней панели совпадает с низом окна
    expect(Math.abs(tabs0.y + tabs0.h - before.innerHeight), `${label}: панель у низа окна`).toBeLessThanOrEqual(1);
  }

  for (const top of [120, 400, 900, 5000, 0]) {
    await scrollMain(page, top);
    await page.waitForTimeout(60);
    const header = await boxOf(page, 'header.top');
    expect(header, `${label}: шапка при прокрутке ${top}`).toEqual(header0);
    if (tabs0) expect(await boxOf(page, 'nav.tabs'), `${label}: панель при прокрутке ${top}`).toEqual(tabs0);
    const s = await pageState(page);
    expect(s.winY + s.docTop + s.bodyTop, `${label}: окно не прокручивается`).toBe(0);
    expect(s.scrollWidth, `${label}: нет горизонтальной прокрутки окна`).toBeLessThanOrEqual(0);
    expect(s.mainOverflowX, `${label}: нет горизонтальной прокрутки области`).toBeLessThanOrEqual(0);
  }
}

test('Оболочка: шапка и нижняя панель не двигаются при прокрутке на экранах агента, дашборда, документов и листа', async ({ page }) => {
  test.setTimeout(180_000);
  await resetChat();
  await firstLogin(page, PIN);
  await holdSession();

  // агент: прокручивается только список сообщений, окно и main стоят
  await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
  await expectShellStill(page, 'агент', { tabs: true });
  const input = page.getByLabel('Вопрос агенту');
  await input.fill('НДС по Альфе за февраль');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expectShellStill(page, 'агент, ответ', { tabs: true });
  const composerBefore = await boxOf(page, '.composer');
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.chat-scroll')!;
    list.scrollTop = 0;
  });
  expect(await boxOf(page, '.composer'), 'поле ввода не двигается при прокрутке списка').toEqual(composerBefore);

  // дашборд
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('main.app-main')!.scrollHeight > document.querySelector<HTMLElement>('main.app-main')!.clientHeight)).toBe(true);
  await expectShellStill(page, 'дашборд', { tabs: true });

  // документы: каталог и список
  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
  await expectShellStill(page, 'документы', { tabs: true });

  // страница документа: нижней панели вкладок нет, шапка стоит; закреплена панель действий листа
  await page.locator('[data-template="contract_rent_no_crew"] [data-action="fill"]').click();
  const dialog = page.getByRole('dialog', { name: /Заполнить:/ });
  await dialog.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
  await expectShellStill(page, 'лист документа', { tabs: false });
  // закреплённая панель действий листа у низа области при любой прокрутке
  const barBefore = await boxOf(page, '[data-testid="sheet-actions"]');
  await scrollMain(page, 700);
  await page.waitForTimeout(60);
  expect(await boxOf(page, '[data-testid="sheet-actions"]')).toEqual(barBefore);

  // уборка: созданный документ не остаётся
  await sql('delete from documents');
});

test('Отступы: первый заголовок каждого экрана не ближе 24 px от шапки на телефоне и 32 px на компьютере', async ({ page }) => {
  test.setTimeout(120_000);
  await resetChat();
  await firstLogin(page, PIN);
  await holdSession();

  const gap = async (selector: string): Promise<{ gap: number; inMain: boolean; scrollTop: number }> =>
    page.evaluate((sel) => {
      const head = document.querySelector('header.top')!.getBoundingClientRect();
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const main = document.querySelector<HTMLElement>('main.app-main')!;
      return { gap: r.top - head.bottom, inMain: main.contains(el), scrollTop: main.scrollTop };
    }, selector);

  // агент: первое, что видно в области, это подсказки (история пуста)
  await expect(page.locator('.chat-empty, .chat').first()).toBeVisible();
  const agentSel = (await page.locator('.chat .msg').count()) > 0 ? '.chat .msg' : '.chat-empty .sug, .sug-handle';
  const agent = await gap(agentSel);
  expect(agent.gap, 'агент').toBeGreaterThanOrEqual(24);
  expect(agent.inMain).toBe(true);

  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  const dash = await gap('#h-group');
  expect(dash.scrollTop).toBe(0);
  expect(dash.gap, 'дашборд').toBeGreaterThanOrEqual(24);
  expect(dash.inMain, 'заголовок внутри прокручиваемой области').toBe(true);

  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
  const docs = await gap('h1#h-docs');
  expect(docs.scrollTop).toBe(0);
  expect(docs.gap, 'документы').toBeGreaterThanOrEqual(24);
  expect(docs.inMain).toBe(true);

  // страница документа
  await page.locator('[data-template="contract_rent_no_crew"] [data-action="fill"]').click();
  await page.getByRole('dialog', { name: /Заполнить:/ }).getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
  const sheet = await gap('[data-testid="sheet-title"]');
  expect(sheet.scrollTop).toBe(0);
  expect(sheet.gap, 'лист документа').toBeGreaterThanOrEqual(24);
  expect(sheet.inMain).toBe(true);

  // статусы из меню (без перезагрузки: она закрыла бы сессию экраном PIN)
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Статусы проверок' }).click();
  await expect(page.locator('#h-statuses')).toBeVisible();
  const st = await gap('#h-statuses');
  expect(st.gap, 'статусы').toBeGreaterThanOrEqual(24);

  // шапка не прилипает и заголовок не уходит под неё: при прокрутке он уезжает вместе с областью
  await page.getByRole('link', { name: 'Дашборд', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await scrollMain(page, 200);
  const after = await gap('#h-group');
  expect(after.gap).toBeLessThan(dash.gap);

  await sql('delete from documents');
});

test.describe('на компьютере', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('отступ не меньше 32 px, боковая панель и шапка на местах при прокрутке', async ({ page }) => {
    await resetChat();
    await firstLogin(page, PIN);
    await holdSession();
    await page.getByRole('link', { name: 'Дашборд' }).click();
    await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
    const m = await page.evaluate(() => {
      const head = document.querySelector('header.top')!.getBoundingClientRect();
      const el = document.querySelector('#h-group')!.getBoundingClientRect();
      const side = document.querySelector('nav.tabs')!.getBoundingClientRect();
      const main = document.querySelector<HTMLElement>('main.app-main')!;
      return { gap: el.top - head.bottom, sideLeft: side.left, sideTop: side.top, sideW: side.width, sideH: side.height, vh: window.innerHeight, mainScrolls: main.scrollHeight > main.clientHeight };
    });
    expect(m.gap).toBeGreaterThanOrEqual(32);
    expect(m.sideLeft).toBe(0);
    expect(m.sideTop).toBe(0);
    expect(m.sideH).toBe(m.vh);
    const header0 = await boxOf(page, 'header.top');
    const side0 = await boxOf(page, 'nav.tabs');
    expect(m.mainScrolls).toBe(true);
    await scrollMain(page, 600);
    expect(await boxOf(page, 'header.top')).toEqual(header0);
    expect(await boxOf(page, 'nav.tabs')).toEqual(side0);
  });
});
