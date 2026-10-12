import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';
const SHOTS = '.data/shots';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const WINE = 'rgb(120, 66, 68)'; // #784244
const LEMON = 'rgb(255, 243, 178)'; // #FFF3B2

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

/** Неразрывные пробелы формата ru-RU сводим к обычным. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

async function toDocuments(page: Page) {
  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
}

async function go(page: Page, tab: 'Агент' | 'Дашборд') {
  await page.getByRole('link', { name: tab, exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(tab === 'Агент' ? '/agent' : '/dashboard');
}

async function startFromCatalog(
  page: Page,
  template: string,
  opts: { entity?: string; kind?: string; month?: string; quarter?: string; year?: string } = {},
) {
  await page.getByRole('tab', { name: 'Каталог шаблонов' }).click();
  await page.locator(`[data-template="${template}"] [data-action="fill"]`).click();
  const dialog = page.getByRole('dialog', { name: /Заполнить:/ });
  await expect(dialog).toBeVisible();
  if (opts.entity) await dialog.getByLabel('Юрлицо').selectOption({ label: opts.entity });
  if (opts.kind) await dialog.getByLabel('Вид периода').selectOption({ label: opts.kind });
  if (opts.year) await dialog.getByLabel('Год').selectOption({ label: opts.year });
  if (opts.month) await dialog.getByLabel('Месяц').selectOption({ label: opts.month });
  if (opts.quarter) await dialog.getByLabel('Квартал').selectOption({ label: opts.quarter });
  await dialog.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('sheet')).toBeVisible();
}

const docId = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;
const sheet = (page: Page) => page.getByTestId('sheet');
const field = (page: Page, key: string) => sheet(page).locator(`[data-field="${key}"]`).first();
const bar = (page: Page) => page.getByTestId('sheet-actions');
const counter = (page: Page) => bar(page).locator('[data-action="missing-first"]');
const status = (page: Page) => page.getByTestId('sheet-meta').locator('.doc-status');

const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Ещё' }).click();
  await expect(page.getByRole('menu', { name: 'Действия с документом' })).toBeVisible();
};
const menuItem = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name });

/** Адрес файла из меню «ещё» (пункт «Скачать»). */
async function fileHref(page: Page): Promise<string> {
  await openMenu(page);
  const href = (await page.getByRole('menuitem', { name: /^Скачать/ }).getAttribute('href'))!;
  await page.keyboard.press('Escape');
  return href;
}

async function fetchFile(page: Page) {
  const href = await fileHref(page);
  const res = await page.request.get(href);
  return { res, href, body: await res.body() };
}

async function docxXml(body: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(body);
  return zip.file('word/document.xml')!.async('string');
}

const textOf = (xml: string) => plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
const nameFrom = (cd: string) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)![1]!);

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const css = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

// ===== навигация и каталог =====

test('Навигация: третья вкладка «Документы» на телефоне и компьютере, иконка 22 px', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.locator('nav.tabs .tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveText('Документы');
  const phone = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.tabs .tab')].map((e) => {
      const r = e.getBoundingClientRect();
      const svg = e.querySelector('svg')!.getBoundingClientRect();
      return { w: r.width, h: r.height, icon: [svg.width, svg.height] };
    });
    return { t, cols: getComputedStyle(document.querySelector('.tabs')!).gridTemplateColumns.split(' ').length };
  });
  expect(phone.cols).toBe(3);
  for (const x of phone.t) {
    expect(x.icon).toEqual([22, 22]);
    expect(x.h).toBeGreaterThanOrEqual(44);
  }
  expect(new Set(phone.t.map((x) => Math.round(x.w))).size).toBe(1);

  await tabs.nth(2).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/documents');
  await expect(tabs.nth(2)).toHaveAttribute('aria-current', 'page');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const desk = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs .tab')].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }),
  );
  expect(desk).toHaveLength(3);
  expect(desk[1]!.y).toBeGreaterThan(desk[0]!.y);
  expect(desk[2]!.y).toBeGreaterThan(desk[1]!.y);
  expect(desk[0]!.x).toBeCloseTo(desk[2]!.x, 0);
});

for (const width of [390, 1440]) {
  test(`Каталог: карточка шаблона и отступ заголовка от шапки, ${width} px`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await toDocuments(page);

    // заголовок «Документы» не прилипает к шапке: от низа шапки не меньше 24 px (телефон), 32 px (компьютер)
    const gap = await page.evaluate(() => {
      const head = document.querySelector('header.top')!.getBoundingClientRect();
      const h1 = document.querySelector('h1')!.getBoundingClientRect();
      return { gap: h1.top - head.bottom, y: window.scrollY };
    });
    expect(gap.y).toBe(0);
    expect(gap.gap).toBeGreaterThanOrEqual(width === 390 ? 24 : 32);
    expect(gap.gap).toBeLessThanOrEqual(width === 390 ? 36 : 44);

    const cards = page.locator('li.tpl');
    await expect(cards).toHaveCount(8);
    for (const card of await cards.all()) {
      await expect(card.locator('h2')).toHaveCount(1);
      await expect(card.locator('.tpl-desc')).toHaveCount(1);
      await expect(card.getByRole('button')).toHaveText('Заполнить');
    }
    await expect(page.locator('.tpl-cat, .tpl-meta')).toHaveCount(0);
    await expect(page.getByText('Образец, проверить юристом')).toHaveCount(0);
    expect(await page.evaluate(() => (document.body.textContent ?? '').split('Демо-данные').length - 1)).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/doc-catalog-${width}.png`, fullPage: true });

    const category = (name: string) => page.getByRole('group', { name: 'Категория' }).getByRole('button', { name, exact: true });
    await category('Договоры').click();
    await expect(cards).toHaveCount(2);
    await category('Допсоглашения').click();
    await expect(cards).toHaveCount(2);
    await category('Отчёты').click();
    await expect(cards).toHaveCount(2);
    await category('Проекты деклараций').click();
    await expect(cards).toHaveCount(2);
    await expect(category('Проекты деклараций')).toHaveAttribute('aria-pressed', 'true');
    await category('Все').click();
    await expect(cards).toHaveCount(8);

    await page.getByLabel('Поиск по названию').fill('справка');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Справка по НДС за период');
    await page.getByLabel('Поиск по названию').fill('несуществующий');
    await expect(cards).toHaveCount(0);
    await expect(page.getByTestId('templates-empty')).toBeVisible();
    await page.getByLabel('Поиск по названию').fill('');
  });
}

test('Прокрутка раздела: открывается в самом начале, при возврате из документа место сохраняется', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await firstLogin(page, PIN);
  await go(page, 'Дашборд');
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  await toDocuments(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, 420));
  await page.waitForTimeout(150);
  await page.locator('[data-template="report_group_summary"] [data-action="fill"]').click();
  const dialog = page.getByRole('dialog', { name: /Заполнить:/ });
  await expect(dialog).toBeVisible();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(200);
  await dialog.getByLabel('Вид периода').selectOption({ label: 'Год' });
  await dialog.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
  // лист открывается с начала
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole('link', { name: 'К документам' }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);

  // из другого раздела раздел «Документы» снова открывается с начала
  await go(page, 'Дашборд');
  await toDocuments(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

// ===== лист документа =====

for (const width of [390, 1440]) {
  test(`Лист: белая страница с текстом, поля подсвечены, закреплённые действия, ${width} px`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await toDocuments(page);
    await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });

    // верхняя панель: назад, название, версия и статус одной строкой, меню «ещё»
    await expect(page.getByRole('link', { name: 'К документам' })).toBeVisible();
    await expect(page.getByTestId('sheet-title')).toHaveText('Договор аренды автомобиля без экипажа, ИП Бета');
    await expect(page.getByTestId('doc-version')).toHaveText('Версия 1');
    await expect(status(page)).toHaveAttribute('data-status', 'draft');
    expect((await page.locator('.sheet-bar').boundingBox())!.height).toBeLessThanOrEqual(64);
    expect((await page.getByTestId('sheet-meta').boundingBox())!.height).toBeLessThan(24);

    // лист: белая страница до 760 px по центру, текст договора с заголовками
    const geo = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="sheet"]')!;
      const r = p.getBoundingClientRect();
      const desk = p.parentElement!.getBoundingClientRect();
      return { w: r.width, left: r.left, right: r.right, bg: getComputedStyle(p).backgroundColor, dl: desk.left, dr: desk.right, vw: window.innerWidth };
    });
    expect(geo.bg).toBe('rgb(255, 255, 255)');
    expect(geo.w).toBeLessThanOrEqual(760.5);
    expect(geo.right).toBeLessThanOrEqual(geo.vw);
    if (width === 1440) expect(Math.abs((geo.left + geo.right) / 2 - (geo.dl + geo.dr) / 2)).toBeLessThanOrEqual(1);
    await expect(sheet(page).locator('h2.sheet-h1')).toContainText('Договор аренды автомобиля без экипажа №');
    await expect(sheet(page).getByText('1. Предмет договора')).toBeVisible();
    await expect(page.getByTestId('file-card')).toHaveCount(0);
    await expect(page.getByText('Условные обозначения')).toHaveCount(0);

    // пропущенные поля: жёлтый #FFF3B2 и «[Название]»
    expect(await sheet(page).locator('[data-state="missing"]').count()).toBeGreaterThanOrEqual(7);
    const first = field(page, 'contract_number');
    await expect(first).toHaveText(/^\[Номер договора\]/);
    expect(await css(first, 'background-color')).toBe(LEMON);
    // заполненные из реквизитов и расчёта: тонкое подчёркивание
    for (const el of [sheet(page).locator('[data-source="entity"]').first(), sheet(page).locator('[data-source="calc"]').first()]) {
      expect(await css(el, 'border-bottom-width')).toBe('1px');
      expect(await css(el, 'border-bottom-style')).toBe('solid');
    }

    // закреплённая нижняя панель: счётчик, «Дозаполнить», «Отправить»
    await expect(bar(page)).toBeVisible();
    await expect(counter(page)).toHaveText('Не заполнено: 7');
    const fill = bar(page).getByRole('button', { name: 'Дозаполнить', exact: true });
    await expect(fill).toBeVisible();
    await page.mouse.move(1, 1);
    await expect.poll(() => css(fill, 'background-color')).toBe(WINE);
    await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
    const sticky = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="sheet-actions"]')!;
      const r = el.getBoundingClientRect();
      return { bottom: r.bottom, vh: window.innerHeight, pos: getComputedStyle(el).position };
    });
    expect(sticky.pos).toBe('sticky');
    expect(sticky.bottom).toBeLessThanOrEqual(sticky.vh + 0.5);
    expect(sticky.bottom).toBeGreaterThan(sticky.vh - 120);
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(150);
    const stuck = (await bar(page).boundingBox())!;
    expect(Math.abs(stuck.y + stuck.height - (await page.evaluate(() => window.innerHeight)))).toBeLessThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // меню «ещё»: скачивание, проверка, история, комментарии; «Править» и «Дозаполнить» в нём нет
    await openMenu(page);
    const items = await page.getByRole('menuitem').allInnerTexts();
    expect(items.map((t) => t.replace(/\s+\d+$/, ''))).toEqual(['Скачать .docx', 'Проверить самому', 'История версий', 'Комментарии']);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${SHOTS}/doc-sheet-${width}.png` });
  });
}

test('Телефон: лист на весь экран, нижней панели вкладок нет, цели нажатия 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });
  await expect(page.locator('nav.tabs')).toBeHidden();
  await expect(page.locator('.docs-rail')).toBeHidden();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.sheet-actions .act, .bar-arrow, .bar-counter, .sheet-bar .icon-btn')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.getBoundingClientRect().height),
  );
  expect(small.length).toBeGreaterThanOrEqual(6);
  for (const h of small) expect(h).toBeGreaterThanOrEqual(43.5);
  await page.getByRole('link', { name: 'К документам' }).click();
  await expect(page.locator('nav.tabs')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
});

test('Компьютер: документ справа от каталога, «на всю ширину» и узкий экран', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });

  const split = await page.evaluate(() => {
    const rail = document.querySelector('.docs-rail')!.getBoundingClientRect();
    const pane = document.querySelector('.docs-pane')!.getBoundingClientRect();
    return { railR: rail.right, paneL: pane.left, railW: rail.width };
  });
  expect(split.railW).toBeGreaterThanOrEqual(300);
  expect(split.paneL).toBeGreaterThan(split.railR);
  // каталог остался на своей вкладке; открытый документ отмечен в списке «Мои документы»
  await expect(page.getByRole('tab', { name: 'Каталог шаблонов' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Мои документы/ }).click();
  await expect(page.locator('li[data-doc].on')).toHaveCount(1);

  await page.getByRole('button', { name: 'На всю ширину' }).click();
  await expect(page.locator('.docs-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Показать рядом с каталогом' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Показать рядом с каталогом' }).click();
  await expect(page.locator('.docs-rail')).toBeVisible();

  // уже 1100 px: каталог скрыт, лист на всю ширину
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.locator('.docs-rail')).toBeHidden();
  await expect(page.getByRole('button', { name: 'На всю ширину' })).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('«Открыть» из списка ведёт на страницу документа в приложении, файл не скачивается', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'март', year: '2026' });
  const id = docId(page);
  await page.getByRole('link', { name: 'К документам' }).click();
  await page.getByRole('tab', { name: /Мои документы/ }).click();

  const item = page.locator(`li[data-doc="${id}"]`);
  const open = item.getByRole('link', { name: 'Открыть', exact: true });
  // обычная ссылка: её можно открыть и в новой вкладке браузера
  await expect(open).toHaveAttribute('href', `/documents/${id}`);
  await expect(open).not.toHaveAttribute('download', /.*/);

  let downloads = 0;
  page.on('download', () => (downloads += 1));
  const files: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/file')) files.push(r.url());
  });
  await open.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/documents/${id}`);
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('sheet-title')).toContainText('Справка по НДС за период');
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  expect(files).toEqual([]);
});

test('Ввод по нажатию: окно значения, новая версия, поле больше не подсвечено', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(counter(page)).toHaveText('Не заполнено: 7');

  await field(page, 'contract_number').click();
  const dialog = page.getByRole('dialog', { name: 'Значение поля: Номер договора' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 1');

  await field(page, 'contract_number').click();
  await dialog.getByRole('textbox').fill('15');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await expect(counter(page)).toHaveText('Не заполнено: 6');
  const saved = field(page, 'contract_number');
  await expect(saved).toHaveAttribute('data-state', 'filled');
  await expect(saved).toHaveAttribute('data-source', 'user');
  await expect(sheet(page).locator('h2.sheet-h1')).toContainText('№ 15');
  expect(await css(saved, 'background-color')).not.toBe(LEMON);

  // неверное значение: ошибка в окне, версия не создаётся (у каждого поля своё имя окна)
  const priceDialog = page.getByRole('dialog', { name: 'Значение поля: Арендная плата за сутки' });
  await field(page, 'rent_price').click();
  await expect(priceDialog).toBeVisible();
  await priceDialog.getByRole('textbox').fill('много');
  await priceDialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(priceDialog.getByRole('alert')).toContainText('сумма');
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await priceDialog.getByRole('textbox').fill('7 500,50');
  await priceDialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(priceDialog).toHaveCount(0);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 3');
  expect(plain(await field(page, 'rent_price').innerText())).toContain('7 500,50 ₽');

  // значение из расчёта вручную не вводится: окна нет
  const rate = field(page, 'vat_rate');
  await expect(rate).toHaveAttribute('data-source', 'calc');
  await rate.click();
  await expect(page.getByRole('dialog', { name: /^Значение поля:/ })).toHaveCount(0);
  expect(await sheet(page).locator('button[data-source="calc"]').count()).toBe(0);

  const rows = await sql<{ n: number }>('select n from document_versions where document_id = $1 order by n', [docId(page)]);
  expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
});

test('Счётчик пропусков: нажатие к первому, стрелки вперёд и назад по кругу', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(counter(page)).toHaveText('Не заполнено: 7');

  const activeField = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.field ?? null);
  const required = ['contract_number', 'contract_date', 'lessee_name', 'car_description', 'rent_term', 'rent_price', 'lessee_details'];
  const firstInText = await page.evaluate((req) => {
    for (const e of document.querySelectorAll<HTMLElement>('[data-state="missing"]')) {
      if (req.includes(e.dataset.field!)) return e.dataset.field!;
    }
    return null;
  }, required);

  await counter(page).click();
  await expect.poll(activeField).toBe(firstInText);
  const inView = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const r = el.getBoundingClientRect();
      const b = document.querySelector('[data-testid="sheet-actions"]')!.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= b.top + 1;
    });
  await expect.poll(inView).toBe(true);

  const next = bar(page).getByRole('button', { name: 'Следующее незаполненное поле' });
  const prev = bar(page).getByRole('button', { name: 'Предыдущее незаполненное поле' });
  await next.click();
  await expect.poll(activeField).not.toBe(firstInText);
  expect(required).toContain(await activeField());
  await prev.click();
  await expect.poll(activeField).toBe(firstInText);
  // назад с первого: последнее по тексту
  await prev.click();
  await expect.poll(async () => required.includes((await activeField()) ?? '') && (await activeField()) !== firstInText).toBe(true);
  await expect.poll(inView).toBe(true);
});

test('«Дозаполнить»: форма только по пропущенным полям, одна новая версия, история версий', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(counter(page)).toHaveText('Не заполнено: 7');

  await bar(page).getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  const form = page.getByTestId('overlay-screen');
  await expect(form).toBeVisible();
  await expect(form.getByLabel(/Номер договора/)).toBeVisible();
  await expect(form.getByLabel(/Наименование юрлица/)).toHaveCount(0);
  await expect(form.getByLabel(/Ставка НДС по расчёту/)).toHaveCount(0);
  await expect(form).toContainText('Не заполнено: 7 полей');
  await form.getByRole('button', { name: 'Предложить формулировку' }).click();
  const option = form.getByRole('list', { name: /Варианты/ }).getByRole('button').first();
  await expect(option).toBeVisible();
  expect(await option.innerText()).not.toMatch(/\d/);
  await option.click();

  await form.getByLabel(/Номер договора/).fill('15');
  await form.getByLabel(/Дата договора/).fill('2026-10-10');
  await form.getByLabel(/Арендатор: наименование или ФИО/).fill('ИП Тестов Т.Т.');
  await form.getByLabel(/Арендатор: реквизиты/).fill('ИНН 990000000099 (демо)');
  await form.getByLabel(/Автомобиль: марка, модель, госномер/).fill('Образцовая модель А000АА41');
  await form.getByLabel(/Срок аренды/).fill('30 суток');
  await form.getByLabel(/Арендная плата за сутки/).fill('7 500,50');
  await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();

  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await expect(bar(page).getByRole('button', { name: 'Дозаполнить', exact: true })).toHaveCount(0);
  await expect(counter(page)).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();
  expect(plain(await field(page, 'rent_price').innerText())).toContain('7 500,50 ₽');
  await expect(sheet(page)).toContainText('Договор аренды автомобиля без экипажа № 15');
  // осталось необязательное «Залог»: подсвечено, но в счётчик не входит
  await expect(field(page, 'deposit')).toHaveAttribute('data-state', 'missing');

  await openMenu(page);
  await menuItem(page, 'История версий').click();
  const history = page.getByTestId('overlay-drawer');
  const versions = history.getByTestId('versions').locator(':scope > li');
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText('Версия 2');
  await expect(versions.first()).toContainText('Номер договора');
  await expect(versions.first()).toContainText(/контрольная сумма [0-9a-f]{12}/);

  // старая версия: открыть можно, править нельзя, поля не нажимаются, панели действий нет
  await versions.nth(1).getByRole('button', { name: 'Открыть версию 1' }).click();
  await expect(page.getByTestId('readonly-note')).toBeVisible();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 1 из 2');
  await expect(bar(page)).toHaveCount(0);
  expect(await sheet(page).locator('button.sf').count()).toBe(0);
  await expect(field(page, 'contract_number')).toHaveText(/^\[Номер договора\]/);
  const old = await fetchFile(page);
  expect(old.href).toContain('version=1');
  expect(nameFrom(old.res.headers()['content-disposition']!)).toBe(
    'Договор аренды автомобиля без экипажа, ООО «Альфа» (версия 1).docx',
  );

  const rows = await sql<{ n: number }>('select n from document_versions where document_id = $1 order by n', [docId(page)]);
  expect(rows.map((r) => r.n)).toEqual([1, 2]);
});

// ===== подсказка источника =====

test('Источник значения: подсказка при наведении и по фокусу', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });
  const tip = page.getByTestId('source-tip');
  await expect(tip).toHaveCount(0);

  await sheet(page).locator('[data-source="entity"]').first().hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Реквизиты юрлица');
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);

  const total = field(page, 'vat_total');
  await total.hover();
  await expect(tip).toContainText('Расчёт: НДС, февраль 2026');
  await page.mouse.move(5, 5);

  await total.focus();
  await expect(tip).toContainText('Расчёт');
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
});

test.describe('Долгое нажатие на телефоне', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('подсказка источника появляется по долгому нажатию, короткое нажатие её не вызывает', async ({ page }) => {
    await firstLogin(page, PIN);
    await page.getByRole('link', { name: 'Документы', exact: true }).click();
    await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });
    const target = sheet(page).locator('[data-source="entity"]').first();
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = async (holdMs: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(holdMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await touch(80);
    await page.waitForTimeout(600);
    await expect(page.getByTestId('source-tip')).toHaveCount(0);
    await touch(700);
    await expect(page.getByTestId('source-tip')).toBeVisible();
    await expect(page.getByTestId('source-tip')).toContainText('Реквизиты юрлица');
  });
});

// ===== файл и суммы =====

test('Скачать из меню: .docx с колонтитулом и выделенными пропусками, имя файла', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });
  await openMenu(page);
  const [download] = await Promise.all([page.waitForEvent('download'), menuItem(page, 'Скачать .docx').click()]);
  expect(download.suggestedFilename()).toBe('Договор аренды автомобиля без экипажа, ИП Бета.docx');

  const { res, body } = await fetchFile(page);
  expect(res.headers()['content-type']).toBe(DOCX);
  expect(res.headers()['content-disposition']).toMatch(/^attachment; /);
  const zip = await JSZip.loadAsync(body);
  const header = await zip.file(/^word\/header\d*\.xml$/)[0]!.async('string');
  expect(header).toContain('Образец, проверить юристом');
  const xml = await zip.file('word/document.xml')!.async('string');
  const marks = [...xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*?<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<w:t[^>]*>([^<]*)<\/w:t>/gs)].map((m) => m[1]);
  expect(marks.length).toBe(9);
  expect(marks).toContain('[Номер договора]');
  await expect(sheet(page)).toBeVisible();
});

test('Декларация: таблица на экране, те же действия, .xlsx из меню', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  await expect(page.getByTestId('sheet-title')).toContainText('Проект декларации по НДС');
  await expect(page.getByTestId('sheet-page')).toHaveAttribute('data-kind', 'xlsx');
  const grid = sheet(page).locator('table.grid-table');
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('draft-mark')).toHaveText('Проект. Не для подачи');
  await expect(grid.getByRole('rowheader', { name: 'Налогоплательщик' })).toBeVisible();
  await expect(grid.getByRole('rowheader', { name: 'Код налогового органа' })).toBeVisible();
  expect(await sheet(page).locator('table.sheet-table tbody tr').count()).toBe(12);
  const code = field(page, 'ifns_code');
  expect(await css(code, 'background-color')).toBe(LEMON);
  await expect(counter(page)).toHaveText('Не заполнено: 1');
  await code.click();
  const dialog = page.getByRole('dialog', { name: 'Значение поля: Код налогового органа' });
  await dialog.getByRole('textbox').fill('9900');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await expect(counter(page)).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();

  const exact = Number(await field(page, 'vat_total').getAttribute('data-value'));
  await openMenu(page);
  await expect(menuItem(page, 'Скачать .xlsx')).toBeVisible();
  await page.keyboard.press('Escape');
  const { res, body } = await fetchFile(page);
  expect(res.headers()['content-type']).toBe(XLSX);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Проект декларации', 'Итог', 'По месяцам', 'Расчёт', 'Источник']);
  const ws = wb.getWorksheet('Проект декларации')!;
  expect(String(ws.getCell('A1').value)).toBe('Проект. Не для подачи');
  let found: number | null = null;
  ws.eachRow((r) => {
    if (String(r.getCell(1).value).startsWith('НДС по расчёту')) found = r.getCell(2).value as number;
  });
  expect(found).toBe(exact);
});

// ===== проверка =====

test('Проверить самому: значения с источником, отметки «сверил» в базе', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ИП Бета', kind: 'Квартал', quarter: '3 квартал', year: '2026' });

  await openMenu(page);
  await menuItem(page, 'Проверить самому').click();
  const screen = page.getByTestId('overlay-screen');
  await expect(screen).toBeVisible();
  await expect(screen.locator('li.chk').first()).toBeVisible();
  await expect(screen.locator('[data-check="field:entity_inn"]')).toContainText('Реквизиты юрлица');
  await expect(screen.locator('[data-check="field:vat_total"]')).toContainText('Расчёт: НДС, 3 квартал 2026');
  await expect(screen.locator('[data-check="field:prepared_by"]')).toContainText('не заполнено');
  await expect(screen.locator('[data-check="field:prepared_by"] input')).toBeDisabled();

  const before = Number((await sql<{ n: string }>('select count(*)::int as n from checks'))[0]!.n);
  const item = screen.locator('[data-check="field:vat_total"]');
  await item.getByRole('checkbox').check();
  await expect(item).toHaveClass(/done/);
  await expect(item.locator('.chk-meta')).toContainText('Сверено');
  await expect.poll(async () => Number((await sql<{ n: string }>('select count(*)::int as n from checks'))[0]!.n)).toBe(before + 1);
  const row = (await sql<{ subject: string; item: string }>('select subject, item from checks order by id desc limit 1'))[0]!;
  expect(row.subject).toBe(`doc:${docId(page)}:v1`);
  expect(row.item).toBe('field:vat_total');

  const shown = plain(await item.locator('.chk-val').innerText());
  await item.getByRole('button', { name: /Показать расчёт/ }).click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  expect(plain(await drawer.getByTestId('calc-total').innerText())).toBe(shown);
});

test('«Показать расчёт» со значка рядом с суммой на листе', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });
  const shown = plain(await field(page, 'vat_total').innerText()).replace(/\s*\(.*$/, '');
  await sheet(page).getByRole('button', { name: 'Показать расчёт: НДС за период' }).click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  expect(plain(await drawer.getByTestId('calc-total').innerText())).toBe(shown);
  expect(await drawer.getByTestId('calc-total').getAttribute('data-amount')).toBe(await field(page, 'vat_total').getAttribute('data-value'));
});

// ===== отправка и согласование =====

test('Отправить: окно с получателем и комментарием; процесс до согласования', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });

  await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  await field(page, 'prepared_by').click();
  const dialog = page.getByRole('dialog', { name: 'Значение поля: Подготовил' });
  await dialog.getByRole('textbox').fill('Образцов О.И.');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await expect(counter(page)).toHaveCount(0);

  expect(await page.evaluate(() => (document.body.textContent ?? '').includes('Письмо не отправляется'))).toBe(false);
  await bar(page).getByRole('button', { name: 'Отправить', exact: true }).click();
  const modal = page.getByTestId('overlay-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('demo-mail-note')).toHaveText('Письмо не отправляется, это демонстрация');
  await expect(modal.getByRole('radio')).toHaveCount(2);
  await modal.getByRole('radio', { name: /Финансовый директор/ }).check();
  await modal.getByLabel('Комментарий').fill('Проверьте итог за год');
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(modal).toHaveCount(0);

  await expect(status(page)).toHaveText(/На проверке/);
  expect(await page.evaluate(() => (document.body.textContent ?? '').includes('Письмо не отправляется'))).toBe(false);
  expect(await sheet(page).locator('button.sf').count()).toBe(0);
  await expect(bar(page).getByRole('button', { name: 'Отозвать' })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toHaveCount(0);

  const demo = page.getByTestId('demo-reply');
  await expect(demo).toContainText('Демо');
  await demo.getByRole('button', { name: 'Замечание' }).click();
  await expect(status(page)).toHaveText(/Есть замечания/);
  await expect(page.getByTestId('more-dot')).toBeVisible();
  await openMenu(page);
  await menuItem(page, /^Комментарии/).click();
  const comments = page.getByTestId('overlay-drawer');
  await expect(comments.getByTestId('comments')).toContainText('Замечание · Демо');
  await expect(comments.getByTestId('comments')).toContainText('Проверьте итог за год');
  await page.keyboard.press('Escape');

  // правка по нажатию на поле: новая версия, статус «Черновик»
  await field(page, 'purpose').click();
  const purpose = page.getByRole('dialog', { name: /Значение поля: Назначение справки/ });
  await purpose.getByRole('textbox').fill('Для сверки с бухгалтером');
  await purpose.getByRole('button', { name: 'Сохранить' }).click();
  await expect(status(page)).toHaveText(/Черновик/);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 3');

  await bar(page).getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(status(page)).toHaveText(/На проверке/);
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(status(page)).toHaveText(/Согласовано/);
  await expect(bar(page).getByRole('button', { name: 'Отправить', exact: true })).toHaveCount(0);

  const approved = (await sql<{ hash: string }>('select hash from document_versions where document_id = $1 and n = 3', [docId(page)]))[0]!.hash;

  // согласованную версию не меняют: правка даёт новую версию и «Черновик»
  await field(page, 'purpose').click();
  const again = page.getByRole('dialog', { name: /Значение поля: Назначение справки/ });
  await again.getByRole('textbox').fill('Изменение после согласования');
  await again.getByRole('button', { name: 'Сохранить' }).click();
  await expect(status(page)).toHaveText(/Черновик/);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 4');

  const after = await sql<{ n: number; hash: string; purpose: string }>(
    `select n, hash, values->'purpose'->>'value' as purpose from document_versions where document_id = $1 order by n`,
    [docId(page)],
  );
  expect(after.map((r) => r.n)).toEqual([1, 2, 3, 4]);
  expect(after[2]!.hash).toBe(approved);
  expect(after[2]!.purpose).toBe('Для сверки с бухгалтером');
  expect(after[3]!.purpose).toBe('Изменение после согласования');
  await expect(sql('update document_versions set body = $1 where document_id = $2', ['x', docId(page)])).rejects.toThrow();

  await openMenu(page);
  await menuItem(page, 'История версий').click();
  const events = page.getByTestId('overlay-drawer').getByTestId('events').locator(':scope > li');
  await expect(events.first()).toBeVisible();
  expect(await events.count()).toBeGreaterThanOrEqual(8);
  const submitted = (await sql<{ data: { recipient: string; comment: string } }>(
    `select data from document_events where document_id = $1 and kind = 'submitted' order by id limit 1`,
    [docId(page)],
  ))[0]!;
  expect(submitted.data.recipient).toContain('Финансовый директор');
  expect(submitted.data.comment).toBe('Проверьте итог за год');
});

test('Отозвать: документ на проверке возвращается в «Отозвано»', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_group_summary', { kind: 'Квартал', quarter: '3 квартал', year: '2026' });
  await bar(page).getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await bar(page).getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(status(page)).toHaveText(/На проверке/);
  await bar(page).getByRole('button', { name: 'Отозвать' }).click();
  await expect(status(page)).toHaveText(/Отозвано/);
});

test('Комментарий к полю: добавить из меню, отметить решённым', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'январь', year: '2026' });
  await expect(page.getByTestId('more-dot')).toHaveCount(0);
  await openMenu(page);
  await menuItem(page, /^Комментарии/).click();
  const side = page.getByTestId('overlay-drawer');
  await side.getByLabel('К чему комментарий').selectOption({ label: 'НДС за период' });
  await side.getByLabel('Комментарий', { exact: true }).fill('Сверить с декларацией прошлого периода');
  await side.getByRole('button', { name: 'Добавить комментарий' }).click();
  const item = side.getByTestId('comments').locator(':scope > li').first();
  await expect(item).toContainText('Сверить с декларацией прошлого периода');
  await expect(item).toContainText('НДС за период');
  await item.getByRole('button', { name: 'Отметить решённым' }).click();
  await expect(side.getByTestId('comments').locator(':scope > li').first()).toContainText('решено');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('more-dot')).toHaveCount(0);
  const rows = await sql<{ resolved: boolean; field_key: string }>(
    'select resolved, field_key from document_comments where document_id = $1',
    [docId(page)],
  );
  expect(rows).toEqual([{ resolved: true, field_key: 'vat_total' }]);
});

// ===== чат =====

test('Сквозной сценарий: суммы листа, чата и Excel совпадают, дозаполнение и согласование', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);

  const input = page.getByLabel('Вопрос агенту');
  await input.fill('НДС по Альфе за февраль');
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
  const answer = page.locator('.msg:not(.me)').last();
  const chatTax = await answer.locator('table').first().locator('tbody tr').first().locator('td').last().innerText();

  await answer.getByRole('button', { name: 'Сформировать документ' }).click();
  const pick = page.getByRole('dialog', { name: 'Сформировать документ' });
  await expect(pick).toBeVisible();
  await expect(pick.locator('[data-template="report_vat_certificate"]')).toBeVisible();
  await expect(pick.locator('[data-template="decl_usn_draft"]')).toHaveCount(0);
  await pick.locator('[data-template="report_vat_certificate"]').click();

  const start = page.getByRole('dialog', { name: /Заполнить:/ });
  await expect(start.getByLabel('Юрлицо')).toHaveValue('alfa');
  await expect(start.getByLabel('Вид периода')).toHaveValue('month');
  await expect(start.getByLabel('Месяц')).toHaveValue('2');
  await start.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents\/[0-9a-f-]{36}$/);
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('sheet-title')).toContainText('Справка по НДС за период, ООО «Альфа», февраль 2026');

  // сумма на листе, в чате, в файле и в Excel расчёта одна и та же
  const exact = Number(await field(page, 'vat_total').getAttribute('data-value'));
  const mln = (exact / 1_000_000).toFixed(2).replace('.', ',');
  expect(plain(chatTax)).toBe(`${mln} млн`);
  const shown = plain(await field(page, 'vat_total').innerText()).replace(/\s*\(.*$/, '');
  const { body } = await fetchFile(page);
  expect(textOf(await docxXml(body))).toContain(shown);

  const calcRes = await page.request.get(`/api/documents/${docId(page)}/download?calc=1`);
  expect(calcRes.headers()['content-type']).toBe(XLSX);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await calcRes.body()) as unknown as ArrayBuffer);
  let inExcel = false;
  wb.eachSheet((ws) =>
    ws.eachRow((row) =>
      row.eachCell((c) => {
        const v = c.value as number | { result?: number } | null;
        const n = typeof v === 'number' ? v : v && typeof v === 'object' ? v.result : undefined;
        if (typeof n === 'number' && Math.abs(n - exact) < 0.005) inExcel = true;
      }),
    ),
  );
  expect(inExcel).toBe(true);

  await bar(page).getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(counter(page)).toHaveCount(0);
  await bar(page).getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('radio', { name: /Бухгалтер/ }).check();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(status(page)).toHaveText(/На проверке/);
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(status(page)).toHaveText(/Согласовано/);
  await page.screenshot({ path: `${SHOTS}/doc-flow-desktop.png` });

  await page.getByRole('link', { name: 'К документам' }).click();
  await page.getByRole('tab', { name: /Мои документы/ }).click();
  const mine = page.getByTestId('doc-item').first();
  await expect(mine).toContainText('Согласовано');
  await expect(mine).toContainText('версия 2');
});

// ===== доступность =====

test('Доступность: каталог, лист, меню, окна и таблица без нарушений axe', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  const scan = async (label: string) => {
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      res.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any.map((a) => a.message).join(';')}`).join(' | ')}`),
    ).toEqual([]);
  };
  await expect(page.locator('li.tpl')).toHaveCount(8);
  await scan('каталог');
  await startFromCatalog(page, 'report_group_summary', { kind: 'Квартал', quarter: '3 квартал', year: '2026' });
  await scan('лист с каталогом рядом');
  await field(page, 'prepared_by').click();
  await expect(page.getByRole('dialog', { name: /Значение поля/ })).toBeVisible();
  await scan('окно значения');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await scan('меню «ещё»');
  await menuItem(page, 'История версий').click();
  await scan('история версий');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await menuItem(page, /^Комментарии/).click();
  await scan('комментарии');
  await page.keyboard.press('Escape');
  await bar(page).getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await scan('форма');
  const unlabeled = await page.getByTestId('overlay-screen').evaluate((p) =>
    [...p.querySelectorAll<HTMLInputElement>('input, textarea, select')]
      .filter((e) => !e.labels?.length && !e.getAttribute('aria-label'))
      .map((e) => e.id || e.tagName),
  );
  expect(unlabeled).toEqual([]);
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('link', { name: 'К документам' }).click();
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  await scan('таблица декларации');
});

// ===== клавиатура =====

test('Меню «ещё»: стрелки, Home и End, Escape возвращает фокус', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'март', year: '2026' });
  const button = page.getByRole('button', { name: 'Ещё' });
  await button.focus();
  await page.keyboard.press('Enter');
  const items = page.getByRole('menuitem');
  await expect(items).toHaveCount(4);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByTestId('sheet-title').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('Поле с клавиатуры: Enter открывает окно значения, Escape возвращает фокус на поле', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  const f = field(page, 'contract_date');
  await f.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Значение поля: Дата договора' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(f).toBeFocused();
});
