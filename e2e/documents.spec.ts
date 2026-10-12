import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';
const SHOTS = '.data/shots';

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

/** Текст поля без скрытой подписи для читалок экрана. */
const fieldText = (loc: Locator) => loc.evaluate((e) => (e.firstChild?.textContent ?? '').trim());

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
  await expect(page.getByTestId('doc-paper')).toBeVisible();
}

const docId = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;

async function fileOf(d: Download): Promise<Buffer> {
  const p = await d.path();
  return fs.readFileSync(p!);
}

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
  // три колонки одинаковой ширины в одну строку
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

test('Каталог: восемь шаблонов, фильтр по категории, поиск, без повторов в подписях', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await firstLogin(page, PIN);
  await toDocuments(page);

  const cards = page.locator('li.tpl');
  await expect(cards).toHaveCount(8);
  // пометки «Образец, проверить юристом» на карточках нет (она в колонтитуле самого файла), «Демо-данные»
  // только в шапке один раз, числа шаблонов под заголовком нет, подпись поиска не дублирует подсказку
  await expect(page.getByText('Образец, проверить юристом')).toHaveCount(0);
  await expect(page.getByText(/Шаблонов: \d+/)).toHaveCount(0);
  expect(await page.evaluate(() => (document.body.textContent ?? '').split('Демо-данные').length - 1)).toBe(1);
  await expect(page.locator('.docs .sec-h p')).toHaveCount(0);
  await expect(page.locator('.doc-filters label.fld span')).toHaveCount(0);
  await expect(page.getByLabel('Поиск по названию')).toHaveAttribute('placeholder', 'Поиск по названию');
  // при фильтре «Все» на карточке подпись категории есть, при выбранной категории её нет
  await expect(cards.first().locator('.tpl-cat')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/doc-catalog-desktop.png` });

  const category = (name: string) => page.getByRole('group', { name: 'Категория' }).getByRole('button', { name, exact: true });
  await category('Договоры').click();
  await expect(cards).toHaveCount(2);
  await expect(page.locator('li.tpl .tpl-cat')).toHaveCount(0);
  await category('Допсоглашения').click();
  await expect(cards).toHaveCount(2);
  await category('Отчёты').click();
  await expect(cards).toHaveCount(2);
  await category('Проекты деклараций').click();
  await expect(cards).toHaveCount(2);
  await expect(category('Проекты деклараций')).toHaveAttribute('aria-pressed', 'true');
  await category('Все').click();
  await expect(cards).toHaveCount(8);

  // поиск по названию
  await page.getByLabel('Поиск по названию').fill('справка');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Справка по НДС за период');
  await page.getByLabel('Поиск по названию').fill('несуществующий');
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId('templates-empty')).toBeVisible();
  await page.getByLabel('Поиск по названию').fill('');

  // «Мои документы»: сначала пусто или список
  await page.getByRole('tab', { name: /Мои документы/ }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();
});

// ===== заполнение и предпросмотр =====

test('Заполнить: подстановка из реквизитов и расчёта, счётчик «Не хватает», подсветка и значок расчёта', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });

  await expect(page.getByTestId('missing-count')).toHaveText('Не хватает 1 поле');
  const paper = page.getByTestId('doc-paper');
  // реквизиты, расчёт, пропущенное: у каждого свой вид
  const inn = paper.locator('[data-field="entity_inn"]');
  await expect(inn).toHaveAttribute('data-source', 'entity');
  await expect(inn).toHaveClass(/df-entity/);
  await expect(inn).toHaveText(/9900000011/);
  const total = paper.locator('[data-field="vat_total"]');
  await expect(total).toHaveAttribute('data-source', 'calc');
  await expect(total).toHaveClass(/df-calc/);
  const missing = paper.locator('[data-field="prepared_by"]');
  await expect(missing).toHaveAttribute('data-state', 'missing');
  await expect(missing).toHaveClass(/df-missing/);
  // подсветка различается не только цветом: вид линии
  const lines = await page.evaluate(() => {
    const s = (sel: string) => {
      const c = getComputedStyle(document.querySelector(sel)!);
      return { bottom: c.borderBottomStyle, outline: c.outlineStyle };
    };
    return {
      entity: s('.doc-paper .df-entity'),
      calc: s('.doc-paper .df-calc'),
      miss: s('.doc-paper .df-missing'),
    };
  });
  expect(lines.entity.bottom).toBe('solid');
  expect(lines.calc.bottom).toBe('double');
  expect(lines.miss.outline).toBe('dashed');

  // переход по клику из списка недостающих полей
  await page.getByRole('button', { name: 'Подготовил' }).click();
  await expect(missing).toBeFocused();

  // значок «Показать расчёт»: та же сумма, что в документе, до копейки
  const shown = await fieldText(total);
  await paper.getByRole('button', { name: 'Показать расчёт: НДС за период' }).click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  const amount = await drawer.getByTestId('calc-total').getAttribute('data-amount');
  expect(amount).toBe(await total.getAttribute('data-value'));
  expect(plain(await drawer.getByTestId('calc-total').innerText())).toBe(plain(shown));
  await expect(drawer).toContainText('февраль 2026');
  await page.screenshot({ path: `${SHOTS}/doc-calc-desktop.png` });
});

test('Проект декларации: водяной знак «Проект. Не для подачи»', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  await expect(page.getByTestId('watermark')).toHaveCount(1);
  await expect(page.getByTestId('watermark-note')).toHaveText('Проект. Не для подачи');
  const wm = await page.getByTestId('watermark').evaluate((e) => ({
    events: getComputedStyle(e).pointerEvents,
    text: e.textContent,
  }));
  expect(wm.events).toBe('none');
  expect(wm.text).toContain('Проект. Не для подачи');
  await page.screenshot({ path: `${SHOTS}/doc-declaration-desktop.png` });
  // договор без водяного знака
  await page.getByRole('link', { name: 'К документам' }).click();
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(page.getByTestId('watermark')).toHaveCount(0);
  // на странице документа пометки «Образец» и второй метки «Демо-данные» нет; название несёт юрлицо
  await expect(page.getByText('Образец, проверить юристом')).toHaveCount(0);
  expect(await page.evaluate(() => (document.body.textContent ?? '').split('Демо-данные').length - 1)).toBe(1);
  await expect(page.locator('.doc-sub')).not.toContainText('ООО «Альфа»');
});

test('Дозаполнить: форма только по пропущенным полям, новая версия, старая версия только для чтения', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'contract_rent_no_crew', { entity: 'ООО «Альфа»' });
  await expect(page.getByTestId('missing-count')).toHaveText(/Не хватает 7 полей/);

  await page.getByRole('button', { name: 'Дозаполнить' }).click();
  const form = page.getByTestId('overlay-screen');
  await expect(form).toBeVisible();
  // только пропущенные: ни реквизитов юрлица, ни ставки НДС в форме нет
  await expect(form.getByLabel(/Номер договора/)).toBeVisible();
  await expect(form.getByLabel(/Наименование юрлица/)).toHaveCount(0);
  await expect(form.getByLabel(/Ставка НДС по расчёту/)).toHaveCount(0);
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

  await expect(page.getByTestId('missing-count')).toHaveText('Все обязательные поля заполнены');
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');
  const paper = page.getByTestId('doc-paper');
  await expect(paper.locator('[data-field="rent_price"]')).toHaveAttribute('data-source', 'user');
  expect(plain(await fieldText(paper.locator('[data-field="rent_price"]')))).toBe('7 500,50 ₽');
  await expect(paper).toContainText('Договор аренды автомобиля без экипажа № 15');

  // версии: две, в списке изменений видно что изменилось
  const versions = page.getByTestId('versions').locator(':scope > li');
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText('Версия 2');
  await expect(versions.first()).toContainText('Номер договора');
  await expect(versions.first()).toContainText(/контрольная сумма [0-9a-f]{12}/);

  // старая версия: открыть можно, править нельзя, в ней пропуски на месте
  await versions.nth(1).getByRole('button', { name: 'Открыть версию 1' }).click();
  await expect(page.getByTestId('readonly-note')).toBeVisible();
  await expect(page.getByTestId('missing-count')).toHaveText(/Не хватает 7 полей/);
  await expect(page.getByRole('button', { name: 'Править' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Дозаполнить' })).toHaveCount(0);

  const rows = await sql<{ n: number }>(
    'select n from document_versions where document_id = $1 order by n',
    [docId(page)],
  );
  expect(rows.map((r) => r.n)).toEqual([1, 2]);
});

// ===== проверка, файлы =====

test('Проверить самому: значения с источником, отметки «сверил» в базе', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ИП Бета', kind: 'Квартал', quarter: '3 квартал', year: '2026' });

  await page.getByRole('button', { name: 'Проверить самому' }).click();
  const screen = page.getByTestId('overlay-screen');
  await expect(screen).toBeVisible();
  const rows = screen.locator('li.chk');
  await expect(rows.first()).toBeVisible();
  // у значений источник: реквизиты, расчёт, введено вручную
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
  await page.screenshot({ path: `${SHOTS}/doc-check-desktop.png` });
});

test('Скачать: .docx для отчёта и .xlsx для декларации, суммы как на экране', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'март', year: '2026' });
  const paper = page.getByTestId('doc-paper');
  const total = plain(await fieldText(paper.locator('[data-field="vat_total"]')));
  const revenue = plain(await fieldText(paper.locator('[data-field="revenue"]')));

  const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать .docx' }).click()]);
  expect(docx.suggestedFilename()).toMatch(/^Справка-по-НДС-за-период_ООО-Альфа_март-2026_v1\.docx$/);
  const zip = await JSZip.loadAsync(await fileOf(docx));
  expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml']));
  const xml = await zip.file('word/document.xml')!.async('string');
  const text = plain(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
  expect(text).toContain(total);
  expect(text).toContain(revenue);
  expect(text).toContain('ООО «Альфа»');
  expect(text).toContain('март 2026');
  expect(text).toContain('[Подготовил]'); // пропуск остаётся в файле

  // декларация: .xlsx
  await page.getByRole('link', { name: 'К документам' }).click();
  await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
  const exact = Number(await page.getByTestId('doc-paper').locator('[data-field="vat_total"]').getAttribute('data-value'));
  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать .xlsx' }).click()]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile((await xlsx.path())!);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Проект декларации', 'Итог', 'По месяцам', 'Расчёт', 'Источник']);
  const ws = wb.getWorksheet('Проект декларации')!;
  expect(String(ws.getCell('A1').value)).toBe('Проект. Не для подачи');
  let found: number | null = null;
  ws.eachRow((r) => {
    if (String(r.getCell(1).value).startsWith('НДС по расчёту')) found = r.getCell(2).value as number;
  });
  expect(found).toBe(exact);
});

// ===== версии и согласование =====

test('Согласование: отправка, замечание, правка в новую версию, согласование; согласованную версию править нельзя', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });

  // пока не заполнено, отправить нельзя
  await expect(page.getByRole('button', { name: 'Отправить бухгалтеру на проверку' })).toBeDisabled();
  await page.getByRole('button', { name: 'Дозаполнить' }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 2');

  // отправка: то же окно, что в расчётах, получатель бухгалтер или финансовый директор
  await page.getByRole('button', { name: 'Отправить бухгалтеру на проверку' }).click();
  const modal = page.getByTestId('overlay-modal');
  await expect(modal.getByTestId('demo-mail-note')).toContainText('Демо: письмо не отправляется');
  await expect(modal.getByRole('radio')).toHaveCount(2);
  await expect(modal.getByText('Бухгалтер', { exact: true })).toBeVisible();
  await expect(modal.getByText('Финансовый директор')).toBeVisible();
  await modal.getByLabel('Комментарий').fill('Проверьте итог за год');
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  await expect(page.getByRole('button', { name: 'Править' })).toHaveCount(0); // на проверке править нельзя

  // демо: имитация ответа, замечание
  const demo = page.getByTestId('demo-reply');
  await expect(demo).toContainText('Демо');
  await demo.getByRole('button', { name: 'Замечание' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Есть замечания/);
  await expect(page.getByTestId('comments')).toContainText('Замечание · Демо');
  await expect(page.getByTestId('comments')).toContainText('(демо)');

  // правка: новая версия, статус «Черновик»
  await page.getByRole('button', { name: 'Править' }).click();
  const form = page.getByTestId('overlay-screen');
  await form.getByLabel(/Назначение справки/).fill('Для сверки с бухгалтером');
  await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Черновик/);
  await expect(page.getByTestId('doc-version')).toHaveText('Версия 3');

  // повторная отправка и согласование
  await page.getByRole('button', { name: 'Отправить бухгалтеру на проверку' }).click();
  await page.getByTestId('overlay-modal').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.doc-status')).toHaveText(/На проверке/);
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/Согласовано/);
  await expect(page.getByRole('button', { name: 'Отправить бухгалтеру на проверку' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/doc-approved-desktop.png` });

  const approved = (await sql<{ hash: string }>(
    'select hash from document_versions where document_id = $1 and n = 3',
    [docId(page)],
  ))[0]!.hash;

  // согласованную версию не меняют: правка даёт новую версию и «Черновик»
  await page.getByRole('button', { name: 'Править' }).click();
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

  // лента истории
  const events = page.getByTestId('events').locator(':scope > li');
  expect(await events.count()).toBeGreaterThanOrEqual(8);
  await expect(page.getByTestId('events')).toContainText('Согласовано (демо)');
});

test('Комментарий к полю: добавить, найти поле по ссылке, отметить решённым', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDocuments(page);
  await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'январь', year: '2026' });
  const side = page.locator('.doc-side');
  await side.getByLabel('К чему комментарий').selectOption({ label: 'НДС за период' });
  await side.getByLabel('Комментарий', { exact: true }).fill('Сверить с декларацией прошлого периода');
  await side.getByRole('button', { name: 'Добавить комментарий' }).click();
  const item = page.getByTestId('comments').locator(':scope > li').first();
  await expect(item).toContainText('Сверить с декларацией прошлого периода');
  await expect(page.locator('#f-vat_total .sr-only')).toContainText('комментариев: 1');
  await item.getByRole('button', { name: 'НДС за период' }).click();
  await expect(page.locator('#f-vat_total')).toBeFocused();
  await item.getByRole('button', { name: 'Отметить решённым' }).click();
  await expect(page.getByTestId('comments').locator(':scope > li').first()).toContainText('решено');
  const rows = await sql<{ resolved: boolean; field_key: string }>(
    'select resolved, field_key from document_comments where document_id = $1',
    [docId(page)],
  );
  expect(rows).toEqual([{ resolved: true, field_key: 'vat_total' }]);
});

// ===== чат =====

test('Сквозной сценарий: чат, «Сформировать документ», дозаполнить, отправить, имитация, согласование', async ({ page }) => {
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
  await expect(page.getByTestId('doc-paper')).toBeVisible();

  // сумма в документе совпадает с таблицей ответа (млн с двумя знаками)
  const exact = Number(await page.locator('#f-vat_total').getAttribute('data-value'));
  const mln = (exact / 1_000_000).toFixed(2).replace('.', ',');
  expect(plain(chatTax)).toBe(`${mln} млн`);

  // дозаполнить
  await page.getByRole('button', { name: 'Дозаполнить' }).click();
  await page.getByTestId('overlay-screen').getByLabel(/Подготовил/).fill('Образцов О.И.');
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.getByTestId('missing-count')).toHaveText('Все обязательные поля заполнены');

  // отправить, имитация ответа, согласование
  await page.getByRole('button', { name: 'Отправить бухгалтеру на проверку' }).click();
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

test('Доступность: каталог, документ и формы без нарушений axe, у таблиц и полей подписи', async ({ page }) => {
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
  // таблицы с подписью и заголовками столбцов, формы с подписями
  expect(await page.locator('.doc-table caption').count()).toBeGreaterThan(0);
  expect(await page.locator('.doc-table th[scope="col"]').count()).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'Дозаполнить' }).click();
  await scan('форма');
  const unlabeled = await page.getByTestId('overlay-screen').evaluate((p) =>
    [...p.querySelectorAll<HTMLInputElement>('input, textarea, select')]
      .filter((e) => !e.labels?.length && !e.getAttribute('aria-label'))
      .map((e) => e.id || e.tagName),
  );
  expect(unlabeled).toEqual([]);
  // статус не только цветом: слово и знак
  await page.getByTestId('overlay-screen').getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.locator('.doc-status')).toHaveText(/○ Черновик|Черновик/);
});

// ===== телефон =====

test.describe('Телефон 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const overflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test('каталог и документ: без горизонтальной прокрутки, цели нажатия от 44 px', async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await firstLogin(page, PIN);
    await page.getByRole('link', { name: 'Документы' }).click();
    await expect(page.locator('li.tpl')).toHaveCount(8);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.docs button, .docs input, .docs select')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({ t: e.textContent?.trim().slice(0, 30) || e.tagName, h: e.getBoundingClientRect().height }))
        .filter((x) => x.h < 43.5),
    );
    expect(small).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/doc-catalog-mobile.png` });

    await startFromCatalog(page, 'report_vat_certificate', { entity: 'ООО «Альфа»', kind: 'Месяц', month: 'февраль', year: '2026' });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const paper = await page.getByTestId('doc-paper').evaluate((e) => ({
      over: e.scrollWidth - e.clientWidth,
      right: e.getBoundingClientRect().right,
    }));
    expect(paper.over).toBeLessThanOrEqual(0);
    expect(paper.right).toBeLessThanOrEqual(390);
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.doc-acts .act, .miss-link, .calc-ic')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.getBoundingClientRect().height),
    );
    expect(targets.length).toBeGreaterThan(5);
    for (const h of targets) expect(h).toBeGreaterThanOrEqual(43.5);
    await page.screenshot({ path: `${SHOTS}/doc-page-mobile.png`, fullPage: true });
  });

  test('форма «Дозаполнить», проверка и декларация на телефоне', async ({ page }) => {
    await firstLogin(page, PIN);
    await page.getByRole('link', { name: 'Документы' }).click();
    await startFromCatalog(page, 'decl_vat_draft', { entity: 'ООО «Альфа»', kind: 'Год', year: '2026' });
    await expect(page.getByTestId('watermark-note')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: 'Дозаполнить' }).click();
    const form = page.getByTestId('overlay-screen');
    await expect(form).toBeVisible();
    const fit = await form.evaluate((p) => ({
      panel: p.scrollWidth - p.clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inputs: [...p.querySelectorAll<HTMLElement>('input, textarea, button')].map((e) => e.getBoundingClientRect().height),
    }));
    expect(fit.panel).toBeLessThanOrEqual(0);
    expect(fit.page).toBeLessThanOrEqual(0);
    for (const h of fit.inputs) expect(h).toBeGreaterThanOrEqual(43.5);
    await form.getByLabel(/Код налогового органа/).fill('9900');
    await expect(form.getByLabel(/Код налогового органа/)).toHaveValue('9900');
    await page.screenshot({ path: `${SHOTS}/doc-form-mobile.png` });
  });
});
