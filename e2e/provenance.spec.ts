import fs from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';
const SHOTS = '.data/shots';

test.describe.configure({ mode: 'serial' });

// ===== помощники =====

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** «1 234 567,89 ₽» → 1234567.89; «1,23 млн» → 1230000. */
function amountOf(text: string): number {
  const mln = /млн/.test(text);
  const n = Number(text.replace(/[^\d,−-]/g, '').replace(',', '.').replace('−', '-'));
  return mln ? n * 1_000_000 : n;
}

async function toDashboard(page: Page) {
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
}

/** Раскрывает баннер группы и возвращает область с его расшифровкой и кнопками действий. */
async function openBanner(page: Page, index: number): Promise<{ card: Locator; detail: Locator }> {
  const card = page.locator('.sum-card').nth(index);
  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  const detail = wide ? page.locator('#sum-panel') : page.locator('.sum-item.open .acc');
  await expect(detail.locator('[data-action="calc"]')).toBeVisible();
  // дать раскрытию закончиться (450 мс)
  await page.waitForTimeout(600);
  return { card, detail };
}

/** Книга Excel из скачанного файла. */
async function workbookOf(download: import('@playwright/test').Download): Promise<ExcelJS.Workbook> {
  const file = await download.path();
  expect(file).toBeTruthy();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file!);
  return wb;
}

type Cell = ExcelJS.CellValue;
const cached = (v: Cell): number | null => {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'number') return v.result;
  // exceljs при чтении теряет кэш нулевого результата формулы (в файле он записан как <v>0</v>)
  if (v && typeof v === 'object' && 'formula' in v) return 0;
  return null;
};
const isFormula = (v: Cell) => Boolean(v && typeof v === 'object' && 'formula' in v && typeof v.formula === 'string');

/** Итог группы и строки юрлиц с листа «Итог» первого блока. */
function totalsOf(wb: ExcelJS.Workbook): {
  total: number | null;
  revenue: number | null;
  byName: Map<string, number | null>;
  revByName: Map<string, number | null>;
} {
  const ws = wb.getWorksheet('Итог')!;
  const byName = new Map<string, number | null>();
  const revByName = new Map<string, number | null>();
  let total: number | null = null;
  let revenue: number | null = null;
  let inFirst = true;
  ws.eachRow((row) => {
    if (!inFirst) return;
    const a = String(row.getCell(1).value ?? '');
    if (a === 'Итого по группе' || a === 'Итого') {
      total = cached(row.getCell(5).value);
      revenue = cached(row.getCell(4).value);
      inFirst = false;
    } else if (row.getCell(2).value && row.getCell(5).value !== undefined && a !== 'Юрлицо') {
      byName.set(a, cached(row.getCell(5).value));
      revByName.set(a, cached(row.getCell(4).value));
    }
  });
  return { total, revenue, byName, revByName };
}

function formulaCount(wb: ExcelJS.Workbook, sheet: string): number {
  let n = 0;
  wb.getWorksheet(sheet)!.eachRow((row) => row.eachCell((c) => (isFormula(c.value as Cell) ? (n += 1) : 0)));
  return n;
}

// ===== компьютер =====

test('Дашборд: строка происхождения под баннерами, карточками и ставками, метка «Демо-данные» в шапке', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await firstLogin(page, PIN);
  await toDashboard(page);

  // метка в шапке ровно один раз
  await expect(page.locator('header.top [data-testid="demo-badge"]')).toHaveCount(1);
  await expect(page.locator('header.top')).toContainText('Демо-данные');
  expect(await page.locator('header.top').innerText()).toMatch(/Демо-данные/);

  // у четырёх баннеров строка одинаковая, поэтому она стоит один раз под заголовком группы:
  // «источник · обновлено · метка», без юрлица, периода и без метки «Демо-данные» (она в шапке)
  const line = /^Выгрузка из 1С · обновлено 10\.10, 18:00 · (факт|прогноз|факт и прогноз)$/;
  const banners = page.locator('.sum-card');
  await expect(banners).toHaveCount(4);
  const shared = page.locator('.sum > [data-testid="source-line"]');
  await expect(shared).toHaveCount(1);
  await expect(shared).toHaveText(line);
  await expect(shared).not.toContainText('Демо-данные');
  // текущий месяц ещё не закончен: основа «факт и прогноз»
  await expect(shared).toContainText('факт и прогноз');
  await expect(page.locator('.sum-card [data-testid="source-line"]')).toHaveCount(0);

  // у блоков карточки юрлица (цифры, ставки, налог режима) основа одна, поэтому строка в карточке одна
  const cards = page.locator('article.ent');
  await expect(cards).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    const lines = cards.nth(i).locator('[data-testid="source-line"]');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveText(line);
    await expect(cards.nth(i).locator('[data-testid="actions"] [data-action]')).toHaveCount(4);
  }
  // освобождённое юрлицо: об условных цифрах сказано один раз над ставками, в строке пометки нет
  const delta = cards.filter({ hasText: 'ИП Дельта' });
  await expect(delta.locator('.hint')).toContainText('Сейчас НДС не платится');
  await expect(delta.locator('[data-testid="source-line"]')).not.toContainText('условный');
  // юрлицо в строке не повторяется: оно в заголовке карточки
  const alfa = cards.filter({ hasText: 'ООО «Альфа»' });
  await expect(alfa.locator('[data-testid="source-line"]').first()).not.toContainText('ООО «Альфа»');
  await expect(alfa.locator('[data-testid="source-line"]').first()).not.toContainText('2026');

  // «Демо-данные» в DOM страницы один раз, в шапке
  const occurrences = await page.evaluate(() => (document.body.textContent ?? '').split('Демо-данные').length - 1);
  expect(occurrences).toBe(1);

  await page.screenshot({ path: `${SHOTS}/prov-dashboard-desktop.png`, fullPage: false });
});

/**
 * Баннер → «Показать расчёт» → «Выгрузить в Excel»: цифра на баннере, в панели и в файле одна и та же.
 * Тест короткий нарочно: в сквозной среде сессия блокируется на PIN через 15 секунд после входа.
 */
async function sameAmounts(page: Page, index: number, kind: 'rub2' | 'rub' | 'mln') {
  await firstLogin(page, PIN);
  await toDashboard(page);
  const { card, detail } = await openBanner(page, index);
  await detail.locator('[data-action="calc"]').click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  const total = drawer.getByTestId('calc-total');
  await expect(total).toHaveAttribute('data-amount', /^\d+(\.\d+)?$/);

  // окно открыто, живые цифры стоят: баннер и панель показывают один и тот же расчёт
  const shown = await card.locator('.sum-value').innerText();
  await page.waitForTimeout(1500);
  expect(await card.locator('.sum-value').innerText()).toBe(shown);

  const exact = Number(await total.getAttribute('data-amount'));
  const onScreen = amountOf(shown);
  if (kind === 'mln') expect(Math.abs(onScreen - exact)).toBeLessThanOrEqual(5_000); // млн с двумя знаками
  else if (kind === 'rub') expect(onScreen).toBe(Math.round(exact)); // рубли без копеек
  else expect(onScreen.toFixed(2)).toBe(exact.toFixed(2)); // рубли с копейками
  // панель показывает те же копейки, что хранит расчёт
  expect(amountOf(await total.innerText()).toFixed(2)).toBe(exact.toFixed(2));

  // в панели: шаги формулы, правила с нормой и датой, источник, разбивка по месяцам
  await expect(drawer.getByRole('heading', { name: 'Шаги формулы' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Применённые правила' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Источник' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Разбивка по месяцам' })).toBeVisible();
  await expect(drawer).toContainText('НК РФ, ст. 164');
  await expect(drawer).toContainText('действует с 1 января 2026');
  await expect(drawer).toContainText('Выгрузка из 1С');
  await expect(drawer.locator('[data-month]')).toHaveCount(index === 2 ? 12 : 10);

  // Excel из панели: те же суммы, листы и формулы
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    drawer.locator('[data-action="excel"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^НДС_Группа_.+\.xlsx$/);
  const wb = await workbookOf(download);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Итог', 'По месяцам', 'Расчёт', 'Источник']);
  const t = totalsOf(wb);
  // под баннером «Выручка с начала года» стоит выручка, под остальными налог
  expect((index === 0 ? t.revenue! : t.total!).toFixed(2)).toBe(exact.toFixed(2));
  expect(formulaCount(wb, 'Расчёт')).toBeGreaterThan(20);
  expect(formulaCount(wb, 'Итог')).toBeGreaterThan(0);

  // юрлица в панели и в файле до копейки
  const rows = drawer.locator('[data-entity]');
  const n = await rows.count();
  expect(n).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < n; i++) {
    const name = (await rows.nth(i).locator('b').first().innerText()).trim();
    const taxText = await rows.nth(i).locator('[data-field="tax"]').innerText();
    const revText = await rows.nth(i).locator('[data-field="revenue"]').innerText();
    expect(t.byName.get(name), `${name} в Excel`).not.toBeNull();
    expect(t.byName.get(name)!.toFixed(2)).toBe(amountOf(taxText).toFixed(2));
    expect(t.revByName.get(name)!.toFixed(2)).toBe(amountOf(revText).toFixed(2));
  }

  // источник в файле
  const text: string[] = [];
  wb.getWorksheet('Источник')!.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? ''))));
  expect(text.join('\n')).toContain('Выгрузка из 1С');
  expect(text.join('\n').toLowerCase()).not.toContain('демо');
  expect(text.join('\n')).toContain('10 октября 2026, 18:00');
  return { page, drawer, card };
}

test('Суммы совпадают до копейки: баннер «НДС начислен», панель и Excel', async ({ page }) => {
  const { drawer } = await sameAmounts(page, 1, 'rub2');
  await page.screenshot({ path: `${SHOTS}/prov-drawer-desktop.png` });
  await drawer.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByTestId('overlay-drawer')).toHaveCount(0);
});

test('Суммы совпадают до копейки: баннер «Выручка с начала года», панель и Excel', async ({ page }) => {
  await sameAmounts(page, 0, 'rub');
});

test('Суммы совпадают до копейки: баннер «Прогноз НДС за год», панель и Excel', async ({ page }) => {
  await sameAmounts(page, 2, 'mln');
});

test('После закрытия окна живые цифры снова идут', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDashboard(page);
  const { card, detail } = await openBanner(page, 0);
  await detail.locator('[data-action="calc"]').click();
  await expect(page.getByTestId('overlay-drawer')).toBeVisible();
  await page.getByTestId('overlay-drawer').getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByTestId('overlay-drawer')).toHaveCount(0);
  const before = await card.locator('.sum-value').innerText();
  await page.waitForTimeout(2500);
  expect(await card.locator('.sum-value').innerText()).not.toBe(before);
});

test('Excel из карточки юрлица: файл «НДС_…», формулы, источник и сверка с экраном', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const card = page.locator('article.ent').filter({ hasText: 'ООО «Альфа»' });
  // имя файла из карточки: четыре расчёта юрлица (НДС и УСН, с начала года и за год)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.locator('[data-action="excel"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Расчёт_Альфа_2026\.xlsx$/);
  const wb = await workbookOf(download);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Итог', 'По месяцам', 'Расчёт', 'Источник']);
  expect(formulaCount(wb, 'Расчёт')).toBeGreaterThan(30);

  // лист «Расчёт»: выручка, ставка и вычет лежат отдельными ячейками, итог формулой
  const calc = wb.getWorksheet('Расчёт')!;
  let rateCells = 0;
  let sumFormulas = 0;
  calc.eachRow((row) => {
    const heads = (row.values as Cell[]).map((v) => String(v ?? ''));
    if (heads.includes('Ставка НДС, %')) rateCells += 1;
    row.eachCell((c) => {
      const v = c.value as Cell;
      if (isFormula(v) && /^ROUND\(SUM\(/.test((v as { formula: string }).formula)) sumFormulas += 1;
    });
  });
  expect(rateCells).toBeGreaterThan(0);
  expect(sumFormulas).toBeGreaterThan(0);

  // карточка и файл показывают один и тот же итог по НДС
  const metric = card.locator('.ent-m b').first();
  expect(await metric.innerText()).toMatch(/₽/);
  const t = totalsOf(wb);
  expect(t.total).not.toBeNull();
  expect(t.byName.size).toBe(1);
});

test('Проверить самому: чек-лист, ссылка на норму, копирование формул, Excel с формулами', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await firstLogin(page, PIN);
  await toDashboard(page);

  const { detail } = await openBanner(page, 1);
  await detail.locator('[data-action="check"]').click();
  const screen = page.getByTestId('overlay-screen');
  await expect(screen).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Проверить самому' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Формулы словами' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Пошаговая сверка' })).toBeVisible();

  // исходные цифры, правила, шаги по юрлицам, итог; ссылка на норму НК РФ
  await expect(screen.locator('.chk')).toHaveCount(2 + 5 + 1);
  const link = screen.getByRole('link', { name: /НК РФ, ст\. 164/ }).first();
  await expect(link).toHaveAttribute('href', /^https:\/\/www\.consultant\.ru\/document\/cons_doc_LAW_28165\/?$/);
  await expect(screen.locator('[data-testid="source-line"]').first()).toContainText('Выгрузка из 1С');
  await expect(screen.locator('[data-testid="source-line"]').first()).not.toContainText('Демо-данные');

  // скопировать формулы
  await screen.getByRole('button', { name: 'Скопировать формулы' }).click();
  await expect(screen.getByText('Формулы скопированы в буфер обмена.')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Шаг\tЮрлицо\tФормула');
  expect(clip).toMatch(/^s1\t/m);
  expect(clip).toContain('ROUND(x; 2)');

  // Excel с формулами
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    screen.getByRole('button', { name: 'Скачать Excel с формулами' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const wb = await workbookOf(download);
  expect(formulaCount(wb, 'Расчёт')).toBeGreaterThan(20);
  await page.screenshot({ path: `${SHOTS}/prov-check-desktop.png` });
});

test('Проверить самому: отметка «сверил» сохраняется в базе (кто, что, когда) и возвращается при открытии', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const before = Number((await sql<{ n: string }>('select count(*)::int as n from checks'))[0]!.n);
  const { detail } = await openBanner(page, 1);
  await detail.locator('[data-action="check"]').click();
  const screen = page.getByTestId('overlay-screen');
  const first = screen.locator('.chk').first();
  await expect(first).toBeVisible();
  await first.getByRole('checkbox').check();
  await expect(first).toHaveClass(/done/);
  await expect(first.locator('.chk-meta')).toContainText('Сверено');
  await expect
    .poll(async () => Number((await sql<{ n: string }>('select count(*)::int as n from checks'))[0]!.n))
    .toBe(before + 1);
  const row = (
    await sql<{ user_id: string; subject: string; item: string; amount: string; checked_at: Date }>(
      'select user_id, subject, item, amount, checked_at from checks order by id desc limit 1',
    )
  )[0]!;
  expect(row.item).toBe('0:src');
  expect(row.subject).toMatch(/^vat:ytd2026:all:[\d,]+$/);
  expect(Number(row.amount)).toBeGreaterThan(0);
  expect(row.user_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.now() - row.checked_at.getTime()).toBeLessThan(5 * 60_000);

  // закрыли и открыли снова: отметка на месте; снять её можно
  await screen.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByTestId('overlay-screen')).toHaveCount(0);
  await detail.locator('[data-action="check"]').click();
  const again = page.getByTestId('overlay-screen').locator('.chk').first();
  await expect(again).toHaveClass(/done/);
  await again.getByRole('checkbox').uncheck();
  await expect(again).not.toHaveClass(/done/);
  await expect
    .poll(async () => Number((await sql<{ n: string }>('select count(*)::int as n from checks'))[0]!.n))
    .toBe(before);
});

test('Передать специалисту: запись review_requests, подпись «Письмо не отправляется» только в окне, история в «Статусах»', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);
  await page.waitForTimeout(300);

  const before = Number((await sql<{ n: string }>('select count(*)::int as n from review_requests'))[0]!.n);
  const card = page.locator('article.ent').filter({ hasText: 'ООО «Альфа»' });
  await card.locator('[data-action="send"]').click();
  const modal = page.getByTestId('overlay-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('demo-mail-note')).toContainText('Письмо не отправляется');
  await expect(modal.getByRole('radio')).toHaveCount(3);
  await expect(modal.getByText('Финансовый директор')).toBeVisible();
  await expect(modal.getByText('Бухгалтер', { exact: true })).toBeVisible();
  await expect(modal).not.toContainText(/демо/i);

  await modal.getByRole('radio', { name: /Финансовый директор/ }).check();
  await modal.getByLabel('Комментарий').fill('Проверьте ставку и порог');
  await page.screenshot({ path: `${SHOTS}/prov-send-desktop.png` });
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();

  const done = modal.getByTestId('send-done');
  await expect(done).toBeVisible();
  await expect(done).toContainText('Отправлено на проверку');
  // «Письмо не отправляется» в окне один раз (над формой и над подтверждением), слова «демо» нет
  await expect(modal.getByTestId('demo-mail-note')).toContainText('Письмо не отправляется');
  expect(((await modal.innerText()).match(/Письмо не отправляется/g) ?? []).length).toBe(1);
  expect(await modal.innerText()).not.toMatch(/демо/i);
  await expect(done).toContainText('Сергей Примеров, Финансовый директор');

  const rows = await sql<{
    type: string;
    status: string;
    recipient_id: string;
    comment: string;
    title: string;
    magic: string;
    size: number;
    snapshot: { tax: string; total: string | null; steps: unknown[] }[];
    excel_name: string;
  }>(
    `select type, status, recipient_id, comment, title, encode(substr(excel_file, 1, 2), 'escape') as magic,
            length(excel_file) as size, snapshot, excel_name
       from review_requests order by created_at desc limit 1`,
  );
  const r = rows[0]!;
  expect(Number((await sql<{ n: string }>('select count(*)::int as n from review_requests'))[0]!.n)).toBe(before + 1);
  expect(r.type).toBe('calc');
  expect(r.status).toBe('sent');
  expect(r.recipient_id).toBe('demo-cfo');
  expect(r.comment).toBe('Проверьте ставку и порог');
  expect(r.title).toMatch(/ООО «Альфа»/);
  expect(r.magic).toBe('PK'); // файл xlsx это zip
  expect(r.size).toBeGreaterThan(5_000);
  expect(r.snapshot).toHaveLength(4);
  expect(r.snapshot.map((s) => s.tax)).toEqual(['vat', 'vat', 'usn', 'usn']);
  expect(r.snapshot.every((s) => s.steps.length > 0)).toBe(true);
  expect(r.excel_name).toMatch(/^Расчёт_Альфа_2026\.xlsx$/);

  await page.screenshot({ path: `${SHOTS}/prov-send-done-desktop.png` });
});

test('Раздел «Статусы»: история запросов, статус и файл запроса', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Статусы проверок' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/statuses');
  const item = page.getByTestId('review-item').first();
  await expect(item).toBeVisible();
  await expect(item).toContainText('Отправлено на проверку');
  await expect(item).toContainText('Сергей Примеров, Финансовый директор');
  await expect(item).toContainText('Проверьте ставку и порог');
  // «Письмо не отправляется» стоит только внутри окна отправки: ни в заголовке раздела, ни у запросов
  await expect(item).not.toContainText('Письмо не отправляется');
  await expect(page.getByText('Письмо не отправляется')).toHaveCount(0);
  const [file] = await Promise.all([page.waitForEvent('download'), item.getByRole('button', { name: /Скачать/ }).click()]);
  const wb = await workbookOf(file);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Итог', 'По месяцам', 'Расчёт', 'Источник']);
  await page.screenshot({ path: `${SHOTS}/prov-statuses-desktop.png` });
});

test('Прогноз на 2027 год: три ставки, допущения в карточке, пересчёт кнопкой, допущения в панели и в Excel', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);

  const input = page.getByLabel('Вопрос агенту');
  await input.fill('какую ставку выбрать на 2027 год');
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
  const answer = page.locator('.msg:not(.me)').last();

  // не отказ, а расчёт: карточка с допущениями одной строкой, таблица по трём ставкам, окно выбора
  await expect(answer).not.toContainText('жду дефлятор');
  await expect(answer.locator('.understood .u-text')).toContainText('Понял так: Вся группа, НДС, 2027 год (прогноз)');
  await expect(answer.locator('.understood .u-notes')).toHaveText(
    'Выручка как в 2026, лимиты как в 2026 (дефлятор не утверждён).',
  );
  await expect(answer.locator('table').first().locator('thead th')).toHaveText(['Юрлицо', '5%', '7%', '22%']);
  await expect(answer.locator('table').first().locator('td.best').first()).toBeVisible();
  await expect(answer).toContainText('Ставку на 2027 год выбирают в ноябре и декабре 2026 года.');
  await expect(answer.getByRole('group', { name: 'Быстрые ответы' }).locator('.qreply')).toHaveText([
    'Рост +10%',
    'Рост +20%',
    'Только Альфа',
  ]);
  // строка происхождения без юрлица и периода, подпись «Цифры из калькулятора» не повторяет её
  await expect(answer.locator('[data-testid="source-line"]')).toHaveText(/^Выгрузка из 1С · обновлено 10\.10, 18:00 · прогноз$/);
  await expect(answer.getByText('Цифры из калькулятора')).toHaveCount(0);
  // формировать документ по прогнозу не из чего: кнопки нет
  await expect(answer.getByRole('button', { name: 'Сформировать документ' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/prov-forecast-desktop.png` });

  // «Рост +10%»: тот же расчёт с другим коэффициентом, цифры в таблице другие
  const before = await answer.locator('table').first().innerText();
  await answer.getByRole('button', { name: 'Рост +10%' }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  const grown = page.locator('.msg:not(.me)').last();
  await expect(grown.locator('.understood .u-notes')).toHaveText(
    'Выручка 2026 года +10%, лимиты как в 2026 (дефлятор не утверждён).',
  );
  expect(await grown.locator('table').first().innerText()).not.toBe(before);

  // допущения в панели «Показать расчёт»: по вкладке на ставку
  await grown.locator('[data-action="calc"]').click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('tab')).toHaveText([
    'НДС, 2027 год, прогноз по ставке 5%',
    'НДС, 2027 год, прогноз по ставке 7%',
    'НДС, 2027 год, прогноз по ставке 22%',
  ]);
  const assumptions = drawer.getByTestId('calc-assumptions');
  await expect(assumptions).toContainText('с ростом 10%');
  await expect(assumptions).toContainText('Лимиты 2027 года как в 2026 (дефлятор не утверждён)');
  await drawer.getByRole('button', { name: 'Закрыть' }).first().click();
  await expect(drawer).toBeHidden();

  // допущения в Excel
  const [file] = await Promise.all([page.waitForEvent('download'), grown.locator('[data-action="excel"]').click()]);
  const wb = await workbookOf(file);
  const text: string[] = [];
  wb.getWorksheet('Источник')!.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? ''))));
  const all = text.join('\n');
  expect(all).toContain('Допущения');
  expect(all).toContain('с ростом 10%');
  expect(all).toContain('дефлятор не утверждён');

  // «Только Альфа» сохраняет рост
  await grown.getByRole('button', { name: 'Только Альфа' }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  const one = page.locator('.msg:not(.me)').last();
  await expect(one.locator('.understood .u-text')).toContainText('ООО «Альфа»');
  await expect(one.locator('.understood .u-notes')).toContainText('+10%');
  await expect(one.locator('table tbody tr')).toHaveCount(1);
});

test('Чат: строка происхождения и действия под ответом, суммы сходятся', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);

  const input = page.getByLabel('Вопрос агенту');
  await input.fill('НДС по Альфе за февраль');
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
  const answer = page.locator('.msg:not(.me)').last();

  await expect(answer.locator('[data-testid="source-line"]')).toHaveText(
    /^Выгрузка из 1С · обновлено 10\.10, 18:00 · факт$/,
  );
  // юрлицо и период в карточке «Понял так» над ответом, в строке они не повторяются
  await expect(answer.locator('.understood')).toContainText('ООО «Альфа»');
  await expect(answer.locator('.understood')).toContainText('февраль 2026');
  const bar = answer.locator('[data-testid="actions"]');
  await expect(bar.locator('[data-action]')).toHaveCount(4);
  await page.screenshot({ path: `${SHOTS}/prov-chat-desktop.png` });

  await bar.locator('[data-action="calc"]').click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  const total = drawer.getByTestId('calc-total');
  await expect(total).toHaveAttribute('data-amount', /^\d+(\.\d+)?$/);
  const exact = Number(await total.getAttribute('data-amount'));

  // таблица ответа (млн с двумя знаками) и панель считают одно и то же
  const tableTax = await answer.locator('table').first().locator('tbody tr').first().locator('td').last().innerText();
  expect(Math.abs(amountOf(tableTax) - exact)).toBeLessThanOrEqual(5_000);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    drawer.locator('[data-action="excel"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('НДС_Альфа_2026-02.xlsx');
  const wb = await workbookOf(download);
  expect(totalsOf(wb).total!.toFixed(2)).toBe(exact.toFixed(2));
  expect(formulaCount(wb, 'Расчёт')).toBeGreaterThan(0);
});

// ===== телефон =====

test.describe('Телефон 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const noScrollX = (page: Page) =>
    page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));

  async function overlayFits(page: Page, testId: string) {
    const fit = await page.getByTestId(testId).evaluate((panel) => {
      const scroll = panel.querySelector('.ov-scroll') as HTMLElement;
      const wide = [...panel.querySelectorAll<HTMLElement>('*')].filter(
        (el) => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed',
      );
      return {
        panel: panel.scrollWidth - panel.clientWidth,
        scroll: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
        outside: wide.map((e) => e.className).slice(0, 5),
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(fit.panel).toBeLessThanOrEqual(0);
    expect(fit.scroll).toBeLessThanOrEqual(0);
    expect(fit.outside).toEqual([]);
    expect(fit.page).toBeLessThanOrEqual(0);
  }

  test('дашборд и панель расчёта: строки, кнопки от 44 px в несколько рядов, без горизонтальной прокрутки', async ({
    page,
  }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await firstLogin(page, PIN);
    await toDashboard(page);

    // строки происхождения на месте и не раздувают страницу
    const lines = page.locator('[data-testid="source-line"]');
    expect(await lines.count()).toBeGreaterThanOrEqual(1 + 5 + 1);
    expect(await noScrollX(page)).toEqual({ page: 0, body: 0 });
    // мелкий шрифт, не больше трёх строк в общей строке над баннерами
    const lineBox = await page.locator('.sum > [data-testid="source-line"]').first().evaluate((e) => {
      const s = getComputedStyle(e);
      const lh = parseFloat(s.lineHeight);
      return { size: parseFloat(s.fontSize), lines: Math.round(e.getBoundingClientRect().height / lh) };
    });
    expect(lineBox.size).toBeLessThanOrEqual(12);
    expect(lineBox.lines).toBeLessThanOrEqual(3);

    // баннер: кнопки переносятся рядами, цель нажатия не меньше 44 px
    const { detail } = await openBanner(page, 1);
    const buttons = detail.locator('[data-testid="actions"] .act');
    await expect(buttons).toHaveCount(4);
    const boxes = await buttons.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { y: Math.round(r.top), h: r.height, right: r.right };
      }),
    );
    for (const b of boxes) {
      expect(b.h).toBeGreaterThanOrEqual(44);
      expect(b.right).toBeLessThanOrEqual(390);
    }
    expect(new Set(boxes.map((b) => b.y)).size).toBeGreaterThanOrEqual(2);
    expect(await noScrollX(page)).toEqual({ page: 0, body: 0 });
    await page.screenshot({ path: `${SHOTS}/prov-banner-mobile.png` });

    // карточка юрлица: строки под блоками и набор кнопок внутри ширины
    const card = page.locator('article.ent').first();
    await card.scrollIntoViewIfNeeded();
    const cardBoxes = await card.locator('[data-testid="actions"] .act').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { h: r.height, right: r.right };
      }),
    );
    expect(cardBoxes).toHaveLength(4);
    for (const b of cardBoxes) {
      expect(b.h).toBeGreaterThanOrEqual(44);
      expect(b.right).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: `${SHOTS}/prov-card-mobile.png` });

    // панель расчёта: нижний лист
    await detail.locator('[data-action="calc"]').scrollIntoViewIfNeeded();
    await detail.locator('[data-action="calc"]').click();
    await expect(page.getByTestId('overlay-drawer')).toBeVisible();
    await expect(page.getByTestId('calc-total')).not.toHaveText('');
    await overlayFits(page, 'overlay-drawer');
    const sheet = await page.getByTestId('overlay-drawer').boundingBox();
    expect(sheet!.x).toBeGreaterThanOrEqual(0);
    expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(844 + 1);
    await page.screenshot({ path: `${SHOTS}/prov-drawer-mobile.png` });
    const footer = await page
      .getByTestId('overlay-drawer')
      .locator('.ov-foot .act')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(footer).toHaveLength(3);
    for (const h of footer) expect(h).toBeGreaterThanOrEqual(44);
  });

  test('«Проверить самому» на телефоне: экран на всю высоту, без горизонтальной прокрутки', async ({ page }) => {
    await firstLogin(page, PIN);
    await toDashboard(page);
    const { detail } = await openBanner(page, 1);
    await detail.locator('[data-action="check"]').scrollIntoViewIfNeeded();
    await detail.locator('[data-action="check"]').click();
    await expect(page.getByTestId('overlay-screen')).toBeVisible();
    await expect(page.getByTestId('overlay-screen').locator('.chk').first()).toBeVisible();
    await overlayFits(page, 'overlay-screen');
    // чекбоксы с областью нажатия не меньше 44 px
    const rows = await page
      .getByTestId('overlay-screen')
      .locator('.chk-row')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(rows.length).toBeGreaterThan(0);
    for (const h of rows) expect(h).toBeGreaterThanOrEqual(44);
    // раскрытые шаги формулы тоже внутри ширины
    await page.getByTestId('overlay-screen').locator('.chk-det summary').nth(3).click();
    await overlayFits(page, 'overlay-screen');
    await page.screenshot({ path: `${SHOTS}/prov-check-mobile.png` });
  });

  test('«Передать специалисту» на телефоне: окно по месту, поле комментария принимает ввод', async ({ page }) => {
    await firstLogin(page, PIN);
    await toDashboard(page);
    const card = page.locator('article.ent').first();
    await card.scrollIntoViewIfNeeded();
    await card.locator('[data-action="send"]').click();
    const modal = page.getByTestId('overlay-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('demo-mail-note')).toBeVisible();
    await modal.getByLabel('Комментарий').fill('Проверьте на телефоне');
    await expect(modal.getByLabel('Комментарий')).toHaveValue('Проверьте на телефоне');
    await overlayFits(page, 'overlay-modal');
    const targets = await modal
      .locator('.send-person, .act')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(targets.length).toBeGreaterThan(3);
    for (const h of targets) expect(h).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${SHOTS}/prov-send-mobile.png` });
  });

  test('чат и «Статусы» на телефоне: строка и кнопки внутри ширины', async ({ page }) => {
    await resetChat();
    await firstLogin(page, PIN);
    const input = page.getByLabel('Вопрос агенту');
    await input.fill('НДС по Альфе за 2 квартал');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(page.locator('.typing')).toHaveCount(0);
    const answer = page.locator('.msg:not(.me)').last();
    await expect(answer.locator('.understood')).toContainText('2 квартал 2026');
    await expect(answer.locator('[data-testid="source-line"]')).toContainText('Выгрузка из 1С');
    const fit = await answer.evaluate((e) => ({
      over: e.scrollWidth - e.clientWidth,
      right: e.getBoundingClientRect().right,
    }));
    expect(fit.over).toBeLessThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(390);
    const heights = await answer.locator('[data-testid="actions"] .act').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights).toHaveLength(4);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${SHOTS}/prov-chat-mobile.png` });

    await page.getByRole('button', { name: 'Меню' }).click();
    await page.getByRole('button', { name: 'Статусы проверок' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/statuses');
    await expect(page.getByRole('heading', { name: 'Статусы' })).toBeVisible();
    expect(await noScrollX(page)).toEqual({ page: 0, body: 0 });
    await page.screenshot({ path: `${SHOTS}/prov-statuses-mobile.png` });
  });
});

