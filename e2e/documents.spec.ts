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
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

async function toDocuments(page: Page) {
  await page.getByRole('link', { name: 'Документы' }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
}

async function startFromCatalog(
  page: Page,
  template: string,
  opts: { entity?: string; kind?: string; month?: string; quarter?: string; year?: string } = {},
) {
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
  await expect(page.getByTestId('file-card')).toBeVisible();
}

const docId = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;
const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Ещё' }).click();
  await expect(page.getByRole('menu', { name: 'Действия с документом' })).toBeVisible();
};
const menuItem = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name });
const fileLink = (page: Page) => page.locator('[data-action="open"]');

/** Файл .docx по ссылке «Открыть»: тот же запрос, что делает браузер. */
async function fetchFile(page: Page) {
  const href = (await fileLink(page).getAttribute('href'))!;
  const res = await page.request.get(href);
  return { res, href, body: await res.body() };
}

async function docxXml(body: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(body);
  return zip.file('word/document.xml')!.async('string');
}

const textOf = (xml: string) => plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));

/** Содержимое пропущенных полей в файле: тексты прогонов с жёлтым выделением. */
const highlighted = (xml: string) =>
  [...xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*?<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<w:t[^>]*>([^<]*)<\/w:t>/gs)].map(
    (m) => m[1]!,
  );

const nameFrom = (cd: string) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)![1]!);

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

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
      return { x: r.left, w: r.width, h: r.height, icon: [svg.width, svg.height] };
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

  // компьютер: боковая панель столбиком, три вкладки
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
  test(`Каталог: карточка шаблона это название, строка описания и «Заполнить», ${width} px`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await toDocuments(page);

    const cards = page.locator('li.tpl');
    await expect(cards).toHaveCount(8);
    // у карточки ровно три части: заголовок, одна строка описания, кнопка
    for (const card of await cards.all()) {
      await expect(card.locator('h2')).toHaveCount(1);
      await expect(card.locator('.tpl-desc')).toHaveCount(1);
      await expect(card.getByRole('button')).toHaveCount(1);
      await expect(card.getByRole('button')).toHaveText('Заполнить');
    }
    // нет меток «Образец», «Демо», повтора категории и числа полей
    await expect(page.locator('.tpl-cat, .tpl-meta')).toHaveCount(0);
    await expect(page.locator('li.tpl').filter({ hasText: /Образец|Демо/ })).toHaveCount(0);
    await expect(page.locator('li.tpl').filter({ hasText: /полей:|файл \./ })).toHaveCount(0);
    await expect(page.getByText('Образец, проверить юристом')).toHaveCount(0);
    expect(await page.evaluate(() => (document.body.textContent ?? '').split('Демо-данные').length - 1)).toBe(1);
    // описание умещается в короткую строку
    const longest = await cards.locator('.tpl-desc').evaluateAll((els) => Math.max(...els.map((e) => (e.textContent ?? '').length)));
    expect(longest).toBeLessThanOrEqual(42);
    // и на экране это одна строка
    const heights = await cards.locator('.tpl-desc').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeLessThan(26);
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

    await page.getByRole('tab', { name: /Мои документы/ }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  });
}

// ===== страница документа: файл вместо предпросмотра =====

for (const width of [390, 1440]) {
  test(`Страница документа: карточка файла, без предпросмотра текста, ${width} px`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await toDocuments(page);
    await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });

    // карточка: значок, имя файла, строка «Версия · статус · обновлён», две основные кнопки
    const card = page.getByTestId('file-card');
    await expect(card).toHaveAttribute('data-kind', 'docx');
    await expect(card.locator('svg.file-ic')).toBeVisible();
    await expect(page.getByTestId('file-name')).toHaveText('Договор аренды автомобиля без экипажа, ИП Бета.docx');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Договор аренды автомобиля без экипажа, ИП Бета.docx');
    const meta = page.getByTestId('file-meta');
    await expect(page.getByTestId('doc-version')).toHaveText('Версия 1');
    // статус меткой со знаком и словом, не только цветом
    await expect(meta.locator('.doc-status')).toHaveText(/○\s*Черновик/);
    await expect(meta.locator('.doc-status')).toHaveAttribute('data-status', 'draft');
    expect(plain((await meta.innerText()).replace(/\s+/g, ' '))).toMatch(/^Версия 1 · ○ черновик · обновлён \d{2}\.\d{2}, \d{2}:\d{2}$/);
    // одна строка и на телефоне
    expect((await meta.boundingBox())!.height).toBeLessThan(26);
    await expect(fileLink(page)).toHaveText('Открыть');
    await expect(card.getByRole('button', { name: 'Отправить', exact: true })).toBeVisible();
    // пока не заполнено, отправить нельзя
    await expect(card.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();

    // текста договора на странице нет
    await expect(page.getByTestId('doc-paper')).toHaveCount(0);
    await expect(page.locator('.df, .doc-paper, .doc-legend, .doc-watermark')).toHaveCount(0);
    const body = await page.evaluate(() => document.body.textContent ?? '');
    expect(body).not.toContain('Предмет договора');
    expect(body).not.toContain('Арендодатель передаёт Арендатору');
    expect(body).not.toContain('Условные обозначения');
    // пометки и пояснения не повторяются на странице
    await expect(page.getByText('Образец, проверить юристом')).toHaveCount(0);
    expect(body.split('Демо-данные').length - 1).toBe(1);
    expect(body).not.toContain('Письмо не отправляется');

    // одна строка про незаполненное; без плашек и отдельной раскраски
    const unfilled = page.getByTestId('unfilled');
    await expect(page.getByTestId('missing-count')).toHaveText('Не заполнено: 7 полей');
    await expect(page.getByTestId('missing-list')).toHaveCount(0);
    await unfilled.getByRole('button', { name: /Не заполнено/ }).click();
    const list = page.getByTestId('missing-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Номер договора');
    await expect(list).toContainText('Дата договора');
    await expect(list.locator('li')).toHaveCount(7);
    await expect(page.locator('.miss-link')).toHaveCount(0);
    const look = await list.evaluate((e) => {
      const c = getComputedStyle(e);
      return { outline: c.outlineStyle, border: c.borderTopStyle, bg: c.backgroundColor };
    });
    expect(look.outline).not.toBe('dashed');
    expect(look.border).not.toBe('dashed');
    await unfilled.getByRole('button', { name: /Не заполнено/ }).click();
    await expect(list).toHaveCount(0);

    // «Дозаполнить» отдельной кнопкой, пока есть пропуски; остальное в меню «ещё»
    await expect(page.getByRole('button', { name: 'Дозаполнить', exact: true })).toBeVisible();
    for (const hidden of ['Проверить самому', 'История версий', 'Комментарии', 'Скачать']) {
      await expect(page.getByRole('button', { name: new RegExp(hidden) })).toHaveCount(0);
    }
    await openMenu(page);
    for (const name of ['Дозаполнить', 'Править', 'Проверить самому', 'История версий', 'Комментарии', 'Скачать .docx']) {
      await expect(menuItem(page, name)).toBeVisible();
    }
    // кнопка меню рядом с заголовком
    const geo = await page.evaluate(() => {
      const h = document.querySelector('h1')!.getBoundingClientRect();
      const b = document.querySelector('.doc-more button')!.getBoundingClientRect();
      return { hTop: h.top, bTop: b.top, bH: b.height, bW: b.width, bRight: b.right, vw: window.innerWidth };
    });
    expect(Math.abs(geo.bTop - geo.hTop)).toBeLessThan(30);
    expect(geo.bH).toBeGreaterThanOrEqual(43.5);
    expect(geo.bW).toBeGreaterThanOrEqual(43.5);
    expect(geo.bRight).toBeLessThanOrEqual(geo.vw);
    await page.screenshot({ path: `${SHOTS}/doc-page-menu-${width}.png` });
    // Escape закрывает меню, фокус возвращается на кнопку
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ещё' })).toBeFocused();

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.file-acts .act, .unfilled .act, .line-toggle, .doc-more .icon-btn')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.getBoundingClientRect().height),
    );
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const h of targets) expect(h).toBeGreaterThanOrEqual(43.5);
    await page.screenshot({ path: `${SHOTS}/doc-page-${width}.png`, fullPage: true });
  });
}

test('Декларация: карточка с файлом .xlsx по той же схеме', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  await expect(page.getByTestId('file-card')).toHaveAttribute('data-kind', 'xlsx');
  await expect(page.getByTestId('file-name')).toHaveText(/^Проект декларации по НДС, ООО «Альфа», .+\.xlsx$/);
  await expect(page.locator('svg.file-ic-xlsx')).toBeVisible();
  await expect(fileLink(page)).toHaveText('Открыть');
  await openMenu(page);
  await expect(menuItem(page, 'Скачать .xlsx')).toBeVisible();
  await expect(page.getByTestId('doc-paper')).toHaveCount(0);
  await expect(page.getByTestId('watermark')).toHaveCount(0);
});

// ===== «Открыть»: файл по прямой ссылке =====

for (const width of [390, 1440]) {
  test(`«Открыть»: файл с верным типом и именем, пропуски выделены жёлтым, ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await toDocuments(page);
    await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ИП Бета' });
    const url = page.url();
    const id = docId(page);

    // ссылка ведёт прямо на файл, а не на страницу приложения
    await expect(fileLink(page)).toHaveAttribute('href', `/api/documents/${id}/file`);
    const { res, body } = await fetchFile(page);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe(DOCX);
    const cd = res.headers()['content-disposition']!;
    expect(cd).toMatch(/^attachment; /);
    expect(nameFrom(cd)).toBe('Договор аренды автомобиля без экипажа, ИП Бета.docx');
    expect(nameFrom(cd)).toBe(await page.getByTestId('file-name').innerText());
    expect(body.subarray(0, 2).toString()).toBe('PK');

    // нажатие скачивает файл (на компьютере он откроется в Word) и не уводит со страницы
    const [download] = await Promise.all([page.waitForEvent('download'), fileLink(page).click()]);
    expect(download.suggestedFilename()).toBe('Договор аренды автомобиля без экипажа, ИП Бета.docx');
    expect(page.url()).toBe(url);
    await expect(page.getByTestId('file-card')).toBeVisible();

    // внутри файла: колонтитул мелким шрифтом, пропуски жёлтым в виде [поле]
    const zip = await JSZip.loadAsync(body);
    const xml = await zip.file('word/document.xml')!.async('string');
    const header = await zip.file(/^word\/header\d*\.xml$/)[0]!.async('string');
    expect(header).toContain('Образец, проверить юристом');
    expect(header).toContain('<w:sz w:val="16"/>');
    // семь обязательных и два необязательных пропуска (залог, особые условия): выделены все
    const marks = highlighted(xml);
    expect(marks.length).toBe(9);
    for (const m of marks) expect(m).toMatch(/^\[.+\]$/);
    expect(marks).toContain('[Номер договора]');
    expect(marks).toContain('[Залог]');
    expect(marks).toContain('[Арендатор: наименование или ФИО]');
    // заполненное из реквизитов и расчёта не выделено
    const text = textOf(xml);
    expect(text).toContain('ИП Бета');
    expect(marks.join('')).not.toContain('Бета');
    expect(text).toMatch(/по ставке \d+%/);
  });
}

test('«Открыть» на iPhone и iPad: ссылка на просмотр во встроенном просмотрщике', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: 'ru-RU',
    timezoneId: 'Asia/Kamchatka',
    baseURL: 'http://localhost:3101',
  });
  const page = await context.newPage();
  try {
    await firstLogin(page, PIN);
    await toDocuments(page);
    await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'март', year: '2026' });
    const link = fileLink(page);
    await expect(link).toHaveAttribute('href', /\/file\?inline=1$/);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).not.toHaveAttribute('download', /.*/);
    const res = await page.request.get((await link.getAttribute('href'))!);
    expect(res.headers()['content-disposition']).toMatch(/^inline; /);
    expect(res.headers()['content-type']).toBe(DOCX);
    expect(nameFrom(res.headers()['content-disposition']!)).toBe('Справка по НДС за период, ООО «Альфа», март 2026.docx');
  } finally {
    await context.close();
  }
});

test('Суммы в файле те же, что в «Проверить самому» и в расчёте', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });
  await openMenu(page);
  await menuItem(page, 'Проверить самому').click();
  const screen = page.getByTestId('overlay-screen');
  await expect(screen).toBeVisible();
  const total = plain(await screen.locator('[data-check="field:vat_total"] .chk-val').innerText());
  const revenue = plain(await screen.locator('[data-check="field:revenue"] .chk-val').innerText());
  await screen.getByRole('button', { name: 'Закрыть' }).click();

  const { body } = await fetchFile(page);
  const text = textOf(await docxXml(body));
  expect(text).toContain(total);
  expect(text).toContain(revenue);
  expect(text).toContain('февраль 2026');
  expect(text).toContain('[Подготовил]');
  expect(highlighted(await docxXml(body))).toContain('[Подготовил]');
});

test('Скачать из меню: .docx для отчёта, .xlsx для декларации с листами расчёта', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'март', year: '2026' });
  await openMenu(page);
  const [docx] = await Promise.all([page.waitForEvent('download'), menuItem(page, 'Скачать .docx').click()]);
  expect(docx.suggestedFilename()).toBe('Справка по НДС за период, ООО «Альфа», март 2026.docx');

  await page.getByRole('link', { name: 'К документам' }).click();
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  const { res, body } = await fetchFile(page);
  expect(res.headers()['content-type']).toBe(XLSX);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Проект декларации', 'Итог', 'По месяцам', 'Расчёт', 'Источник']);
  const ws = wb.getWorksheet('Проект декларации')!;
  expect(String(ws.getCell('A1').value)).toBe('Проект. Не для подачи');
  // пропущенные поля декларации жёлтые и в виде [поле]
  let yellow = 0;
  ws.eachRow((row) => {
    const c = row.getCell(1);
    const fill = c.fill as { fgColor?: { argb?: string } } | undefined;
    if (/\[[^\]]+\]/.test(String(c.value)) && fill?.fgColor?.argb === 'FFFFFF00') yellow += 1;
  });
  expect(yellow).toBeGreaterThan(0);
});

// ===== дозаполнение, версии =====

test('Дозаполнить: форма только по пропущенным полям, новая версия, история версий', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(page.getByTestId('missing-count')).toHaveText('Не заполнено: 7 полей');

  await page.getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  const form = page.getByTestId('overlay-screen');
  await expect(form).toBeVisible();
  // только пропущенные: ни реквизитов юрлица, ни ставки НДС в форме нет
  await expect(form.getByLabel(/Номер договора/)).toBeVisible();
  await expect(form.getByLabel(/Наименование юрлица/)).toHaveCount(0);
  await expect(form.getByLabel(/Ставка НДС по расчёту/)).toHaveCount(0);
  await expect(form).toContainText('Не заполнено: 7 полей');
  // предложение формулировки: слова, без цифр
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

  // строка про незаполненное исчезла, версия 2, файл без выделения
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await expect(page.getByTestId('unfilled')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Дозаполнить', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();
  const { body } = await fetchFile(page);
  const xml = await docxXml(body);
  // обязательное заполнено; необязательный залог остался пустым и в файле остаётся выделенным
  expect(highlighted(xml)).toEqual(['[Залог]']);
  const text = textOf(xml);
  expect(text).toContain('Договор аренды автомобиля без экипажа № 15');
  expect(text).toContain('7 500,50 ₽');
  expect(text).toContain('ИП Тестов Т.Т.');

  // история версий: две версии, видно что изменилось
  await openMenu(page);
  await menuItem(page, 'История версий').click();
  const history = page.getByTestId('overlay-drawer');
  const versions = history.getByTestId('versions').locator(':scope > li');
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText('Версия 2');
  await expect(versions.first()).toContainText('Номер договора');
  await expect(versions.first()).toContainText(/контрольная сумма [0-9a-f]{12}/);

  // старая версия: открыть можно, править нельзя, файл с пропусками на месте
  await versions.nth(1).getByRole('button', { name: 'Открыть версию 1' }).click();
  await expect(page.getByTestId('readonly-note')).toBeVisible();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 1 из 2');
  await expect(page.getByTestId('missing-count')).toHaveText('Не заполнено: 7 полей');
  await expect(page.getByRole('button', { name: 'Дозаполнить', exact: true })).toHaveCount(0);
  await openMenu(page);
  await expect(menuItem(page, 'Править')).toHaveCount(0);
  await expect(menuItem(page, 'Дозаполнить')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const old = await fetchFile(page);
  expect(old.href).toContain('version=1');
  expect(nameFrom(old.res.headers()['content-disposition']!)).toBe(
    'Договор аренды автомобиля без экипажа, ООО «Альфа» (версия 1).docx',
  );
  expect(highlighted(await docxXml(old.body))).toHaveLength(9);

  const rows = await sql<{ n: number }>('select n from document_versions where document_id = $1 order by n', [docId(page)]);
  expect(rows.map((r) => r.n)).toEqual([1, 2]);
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
  const rows = screen.locator('li.chk');
  await expect(rows.first()).toBeVisible();
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
  const row = (await sql<{ subject: string; item: string; amount: string }>(
    'select subject, item, amount from checks order by id desc limit 1',
  ))[0]!;
  expect(row.subject).toBe(`doc:${docId(page)}:v1`);
  expect(row.item).toBe('field:vat_total');
  expect(Number(row.amount)).toBeGreaterThan(0);

  // «Показать расчёт» из проверки: та же сумма, что в документе
  const shown = plain(await item.locator('.chk-val').innerText());
  await item.getByRole('button', { name: /Показать расчёт/ }).click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  expect(plain(await drawer.getByTestId('calc-total').innerText())).toBe(shown);
  await expect(drawer).toContainText('3 квартал 2026');
});

// ===== отправка и согласование =====

test('Отправить: окно с получателем и комментарием, подпись о демо только в нём; процесс до согласования', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });

  // пока не заполнено, отправить нельзя
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');

  // окно: получатель (бухгалтер или финансовый директор), комментарий, «Отправить», одна подпись
  expect(await page.evaluate(() => (document.body.textContent ?? '').includes('Письмо не отправляется'))).toBe(false);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const modal = page.getByTestId('overlay-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('demo-mail-note')).toHaveText('Письмо не отправляется, это демонстрация');
  expect(await page.evaluate(() => (document.body.textContent ?? '').split('Письмо не отправляется').length - 1)).toBe(1);
  await expect(modal.getByRole('radio')).toHaveCount(2);
  await expect(modal.getByText('Бухгалтер', { exact: true })).toBeVisible();
  await expect(modal.getByText('Финансовый директор')).toBeVisible();
  await modal.getByRole('radio', { name: /Финансовый директор/ }).check();
  await modal.getByLabel('Комментарий').fill('Проверьте итог за год');
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(modal).toHaveCount(0);

  // статус «На проверке»; подписи о демо на странице нет, править нельзя
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  expect(await page.evaluate(() => (document.body.textContent ?? '').includes('Письмо не отправляется'))).toBe(false);
  await expect(page.getByTestId('reviewer')).toContainText('Финансовый директор');
  await openMenu(page);
  await expect(menuItem(page, 'Править')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Отозвать' })).toBeVisible();

  // демо: ответ бухгалтера, замечание
  const demo = page.getByTestId('demo-reply');
  await expect(demo).toContainText('Демо');
  await demo.getByRole('button', { name: 'Замечание' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Есть замечания/);
  await expect(page.getByRole('button', { name: /Комментарии без решения: 2/ })).toBeVisible();
  await openMenu(page);
  await menuItem(page, /^Комментарии/).click();
  const comments = page.getByTestId('overlay-drawer');
  await expect(comments.getByTestId('comments')).toContainText('Замечание · Демо');
  await expect(comments.getByTestId('comments')).toContainText('(демо)');
  await expect(comments.getByTestId('comments')).toContainText('Проверьте итог за год');
  await page.keyboard.press('Escape');

  // правка: новая версия, статус «Черновик»
  await openMenu(page);
  await menuItem(page, 'Править').click();
  const form = page.getByTestId('overlay-screen');
  await form.getByLabel(/Назначение справки/).fill('Для сверки с бухгалтером');
  await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Черновик/);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 3');

  // повторная отправка и согласование
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Согласовано/);
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toHaveCount(0);

  const approved = (await sql<{ hash: string }>(
    'select hash from document_versions where document_id = $1 and n = 3',
    [docId(page)],
  ))[0]!.hash;

  // согласованную версию не меняют: правка даёт новую версию и «Черновик»
  await openMenu(page);
  await menuItem(page, 'Править').click();
  await page.getByTestId('overlay-screen').getByLabel(/Назначение справки/).fill('Изменение после согласования');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Черновик/);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 4');

  const after = await sql<{ n: number; hash: string; purpose: string }>(
    `select n, hash, values->'purpose'->>'value' as purpose from document_versions where document_id = $1 order by n`,
    [docId(page)],
  );
  expect(after.map((r) => r.n)).toEqual([1, 2, 3, 4]);
  expect(after[2]!.hash).toBe(approved);
  expect(after[2]!.purpose).toBe('Для сверки с бухгалтером');
  expect(after[3]!.purpose).toBe('Изменение после согласования');

  // версия неизменяема на уровне базы
  const doc = await sql<{ status: string }>('select status from documents where id = $1', [docId(page)]);
  expect(doc[0]!.status).toBe('draft');
  await expect(sql('update document_versions set body = $1 where document_id = $2', ['x', docId(page)])).rejects.toThrow();

  // лента событий в истории версий
  await openMenu(page);
  await menuItem(page, 'История версий').click();
  const events = page.getByTestId('overlay-drawer').getByTestId('events').locator(':scope > li');
  await expect(events.first()).toBeVisible();
  expect(await events.count()).toBeGreaterThanOrEqual(8);
  await expect(page.getByTestId('events')).toContainText('Согласовано (демо)');
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
  await page.getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  await page.getByRole('button', { name: 'Отозвать' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Отозвано/);
});

test('Комментарий к полю: добавить из меню, отметить решённым', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'январь', year: '2026' });
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
  // решённых без решения не осталось: строки про комментарии на странице нет
  await expect(page.getByRole('button', { name: /Комментарии без решения/ })).toHaveCount(0);
  const rows = await sql<{ resolved: boolean; field_key: string }>(
    'select resolved, field_key from document_comments where document_id = $1',
    [docId(page)],
  );
  expect(rows).toEqual([{ resolved: true, field_key: 'vat_total' }]);
});

// ===== чат =====

test('Сквозной сценарий: чат, «Сформировать документ», дозаполнить, отправить, согласование', async ({ page }) => {
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
  // подходящие: справка и декларация по НДС, договоры и допсоглашения по юрлицу; УСН не предлагается
  await expect(pick.locator('[data-template="report_vat_certificate"]')).toBeVisible();
  await expect(pick.locator('[data-template="decl_usn_draft"]')).toHaveCount(0);
  await pick.locator('[data-template="report_vat_certificate"]').click();

  // юрлицо и период из вопроса уже подставлены
  const start = page.getByRole('dialog', { name: /Заполнить:/ });
  await expect(start.getByLabel('Юрлицо')).toHaveValue('alfa');
  await expect(start.getByLabel('Вид периода')).toHaveValue('month');
  await expect(start.getByLabel('Месяц')).toHaveValue('2');
  await start.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('file-card')).toBeVisible();
  await expect(page.getByTestId('file-name')).toHaveText('Справка по НДС за период, ООО «Альфа», февраль 2026.docx');

  // сумма в файле совпадает с таблицей ответа (млн с двумя знаками)
  await openMenu(page);
  await menuItem(page, 'Проверить самому').click();
  const screen = page.getByTestId('overlay-screen');
  const exact = Number(
    (await sql<{ v: string }>(
      `select values->'vat_total'->>'value' as v from document_versions where document_id = $1 and n = 1`,
      [docId(page)],
    ))[0]!.v,
  );
  const mln = (exact / 1_000_000).toFixed(2).replace('.', ',');
  expect(plain(chatTax)).toBe(`${mln} млн`);
  const shown = plain(await screen.locator('[data-check="field:vat_total"] .chk-val').innerText());
  await screen.getByRole('button', { name: 'Закрыть' }).click();
  const { body } = await fetchFile(page);
  expect(textOf(await docxXml(body))).toContain(shown);

  // дозаполнить
  await page.getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('unfilled')).toHaveCount(0);

  // отправить, имитация ответа, согласование
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('overlay-modal').getByRole('radio', { name: /Бухгалтер/ }).check();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Согласовано/);
  await page.screenshot({ path: `${SHOTS}/doc-flow-desktop.png` });

  // «Мои документы»: документ со статусом
  await page.getByRole('link', { name: 'К документам' }).click();
  await page.getByRole('tab', { name: /Мои документы/ }).click();
  const mine = page.getByTestId('doc-item').first();
  await expect(mine).toContainText('Согласовано');
  await expect(mine).toContainText('версия 2');
});

// ===== доступность =====

test('Доступность: каталог, страница документа, меню и окна без нарушений axe', async ({ page }) => {
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
  await scan('документ');
  await page.getByTestId('unfilled').getByRole('button', { name: /Не заполнено/ }).click();
  await scan('документ, список незаполненного');
  await openMenu(page);
  await scan('меню «ещё»');
  await menuItem(page, 'История версий').click();
  await scan('история версий');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await menuItem(page, /^Комментарии/).click();
  await scan('комментарии');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Дозаполнить', exact: true }).click();
  await scan('форма');
  const unlabeled = await page.getByTestId('overlay-screen').evaluate((p) =>
    [...p.querySelectorAll<HTMLInputElement>('input, textarea, select')]
      .filter((e) => !e.labels?.length && !e.getAttribute('aria-label'))
      .map((e) => e.id || e.tagName),
  );
  expect(unlabeled).toEqual([]);
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Отправить', exact: true }).waitFor({ state: 'visible' });
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
  // нажатие вне меню закрывает
  await button.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByTestId('file-name').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});
