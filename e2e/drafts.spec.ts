import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, holdSession, resetChat, typePin } from './helpers';

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

const docId = (page: Page) => /\/documents\/([0-9a-f-]{36})/.exec(new URL(page.url()).pathname)![1]!;

/** Список документов без перезагрузки страницы: она блокирует сессию экраном PIN. */
async function toList(page: Page): Promise<void> {
  // переход мог начаться только что: ждём, пока адрес и страница сойдутся
  await page.waitForTimeout(150);
  const path = new URL(page.url()).pathname;
  if (/^\/documents\/[0-9a-f-]{36}$/.test(path)) {
    await page.getByRole('link', { name: 'К документам' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/documents');
  } else if (path !== '/documents') {
    await page.getByRole('link', { name: 'Документы', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/documents');
  }
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
}

/** Создаёт черновик из шаблона «Договор аренды без экипажа» и возвращает его номер. Остаётся на листе. */
async function createDraft(page: Page): Promise<string> {
  await toList(page);
  await page.getByRole('tab', { name: 'Каталог шаблонов' }).click();
  await page.locator('[data-template="contract_rent_no_crew"] [data-action="fill"]').click();
  await page.getByRole('dialog', { name: /Заполнить:/ }).getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
  return docId(page);
}

/** Согласованный документ: справка, отправка, имитация согласования. */
async function createApproved(page: Page): Promise<string> {
  await toList(page);
  await page.getByRole('tab', { name: 'Каталог шаблонов' }).click();
  await page.locator('[data-template="report_vat_certificate"] [data-action="fill"]').click();
  const start = page.getByRole('dialog', { name: /Заполнить:/ });
  await start.getByLabel('Вид периода').selectOption({ label: 'Месяц' });
  await start.getByRole('button', { name: 'Заполнить', exact: true }).click();
  await expect(page.getByTestId('sheet')).toBeVisible();
  const id = docId(page);
  await page.locator('[data-action="complete"]').click();
  const form = page.getByTestId('overlay-screen');
  await form.getByLabel(/Подготовил/).fill('Образцов О.И.');
  await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();
  await expect(page.locator('[data-action="complete"]')).toHaveCount(0);
  return id;
}

async function sendAndApprove(page: Page): Promise<void> {
  await page.locator('[data-action="submit"]').click();
  const modal = page.getByTestId('overlay-modal');
  await modal.getByRole('radio', { name: /Бухгалтер/ }).check();
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByTestId('demo-reply').getByRole('button', { name: 'Согласовать' }).click();
  await expect(page.getByTestId('sheet-meta')).toContainText(/согласовано/i);
}

const mine = async (page: Page) => {
  await page.getByRole('tab', { name: /Мои документы/ }).click();
};
const item = (page: Page, id: string) => page.locator(`li[data-doc="${id}"]`);
const toast = (page: Page) => page.getByTestId('toast');

test('Удаление черновика из списка: подтверждение, уведомление, «Отменить», окончательное удаление через сутки', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await holdSession();
  const id = await createDraft(page);
  await page.getByRole('link', { name: 'К документам' }).click();
  await mine(page);
  await expect(item(page, id)).toBeVisible();
  await expect(item(page, id).getByRole('link', { name: 'Открыть' })).toBeVisible();

  // подтверждение: «Отмена» ничего не удаляет
  await item(page, id).getByRole('button', { name: 'Удалить' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить черновик?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Восстановить нельзя');
  // «Удалить» красная, из палитры состояний
  const red = await dialog.getByRole('button', { name: 'Удалить' }).evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(red).toBe('rgb(179, 55, 43)');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(item(page, id)).toBeVisible();
  expect((await sql<{ d: Date | null }>('select deleted_at as d from documents where id = $1', [id]))[0]!.d).toBeNull();

  // удаление: уведомление «Черновик удалён» с «Отменить», документа в списке нет
  await item(page, id).getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('dialog', { name: 'Удалить черновик?' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(toast(page)).toContainText('Черновик удалён');
  await expect(toast(page).getByRole('button', { name: 'Отменить' })).toBeVisible();
  await expect(item(page, id)).toHaveCount(0);
  expect((await sql<{ d: Date | null }>('select deleted_at as d from documents where id = $1', [id]))[0]!.d).not.toBeNull();

  // «Отменить»: документ возвращается
  await toast(page).getByRole('button', { name: 'Отменить' }).click();
  await expect(item(page, id)).toBeVisible();
  await expect(toast(page)).toHaveCount(0);
  expect((await sql<{ d: Date | null }>('select deleted_at as d from documents where id = $1', [id]))[0]!.d).toBeNull();

  // снова удалить и не отменять: уведомление живёт около 8 секунд, потом исчезает
  await item(page, id).getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('dialog', { name: 'Удалить черновик?' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(toast(page)).toBeVisible();
  const shownAt = Date.now();
  await expect(toast(page)).toHaveCount(0, { timeout: 15_000 });
  const lived = Date.now() - shownAt;
  expect(lived).toBeGreaterThan(6_500);
  expect(lived).toBeLessThan(11_000);
  await expect(item(page, id)).toHaveCount(0);

  // через сутки на сервере: строка и версии стираются при ближайшем чтении списка
  await sql(`update documents set deleted_at = now() - interval '25 hours' where id = $1`, [id]);
  // полная загрузка страницы закрывает сессию экраном PIN: вводим его, список читается и очищается
  await page.reload();
  await typePin(page, PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
  await page.getByRole('link', { name: 'Документы', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Документы', level: 1 })).toBeVisible();
  await mine(page);
  await expect(page.getByTestId('docs-empty')).toBeVisible();
  expect(await sql('select 1 from documents where id = $1', [id])).toHaveLength(0);
  expect(await sql('select 1 from document_versions where document_id = $1', [id])).toHaveLength(0);
});

test('Согласованный и документ на проверке не удаляются; на проверке есть «Отозвать»', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await holdSession();

  // согласованный
  const approved = await createApproved(page);
  await sendAndApprove(page);
  await page.getByRole('button', { name: 'Ещё' }).click();
  await expect(page.getByRole('menuitem', { name: 'Удалить' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'К документам' }).click();
  await mine(page);
  await expect(item(page, approved)).toContainText('Согласовано');
  await expect(item(page, approved).getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await expect(item(page, approved).getByRole('button', { name: 'Отозвать' })).toHaveCount(0);

  // на проверке: «Отозвать» вместо «Удалить»
  const review = await createApproved(page);
  await page.locator('[data-action="submit"]').click();
  const modal = page.getByTestId('overlay-modal');
  await modal.getByRole('radio', { name: /Бухгалтер/ }).check();
  await modal.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByTestId('sheet-meta')).toContainText(/на проверке/i);
  await page.getByRole('link', { name: 'К документам' }).click();
  await mine(page);
  await expect(item(page, review)).toContainText('На проверке');
  await expect(item(page, review).getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await item(page, review).getByRole('button', { name: 'Отозвать' }).click();
  await expect(item(page, review)).toContainText('Отозвано');
  await expect(item(page, review).getByRole('button', { name: 'Отозвать' })).toHaveCount(0);

  // сервер тоже не даёт: удаление через интерфейс невозможно, строка осталась
  for (const id of [approved, review]) {
    const rows = await sql<{ d: Date | null }>('select deleted_at as d from documents where id = $1', [id]);
    expect(rows[0]!.d).toBeNull();
  }
});

test('Телефон: удаление из меню «ещё» на странице документа и режим «Выбрать» в списке', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await holdSession();

  // из меню «ещё»: окно подтверждения, затем список и «Отменить»
  const one = await createDraft(page);
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await expect(page.getByRole('dialog', { name: 'Удалить черновик?' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Удалить черновик?' }).getByRole('button', { name: 'Удалить' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/documents');
  await expect(toast(page)).toContainText('Черновик удалён');
  await toast(page).getByRole('button', { name: 'Отменить' }).click();
  await mine(page);
  await expect(item(page, one)).toBeVisible();

  // ещё два черновика, режим «Выбрать»
  const two = await createDraft(page);
  const three = await createDraft(page);
  await toList(page);
  await mine(page);
  await expect(page.locator('li[data-testid="doc-item"]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Удалить выбранные' })).toBeDisabled();
  await page.locator(`li[data-doc="${one}"] input[type="checkbox"]`).check();
  await page.locator(`li[data-doc="${two}"] input[type="checkbox"]`).check();
  await expect(page.getByTestId('sel-count')).toHaveText('Выбрано: 2');
  // цель нажатия не меньше 44 px
  const hit = await page.locator(`li[data-doc="${one}"] .req-pick`).boundingBox();
  expect(hit!.width).toBeGreaterThanOrEqual(43.5);
  expect(hit!.height).toBeGreaterThanOrEqual(43.5);
  await page.getByRole('button', { name: 'Удалить выбранные' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить черновики: 2?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await expect(toast(page)).toContainText('Черновики удалены: 2');
  await expect(page.locator('li[data-testid="doc-item"]')).toHaveCount(1);
  await expect(item(page, three)).toBeVisible();
  // «Отменить» возвращает обоих
  await toast(page).getByRole('button', { name: 'Отменить' }).click();
  await expect(page.locator('li[data-testid="doc-item"]')).toHaveCount(3);
  // нет горизонтальной прокрутки
  expect(
    await page.evaluate(() => {
      const m = document.querySelector<HTMLElement>('main.app-main')!;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, m.scrollWidth - m.clientWidth);
    }),
  ).toBeLessThanOrEqual(0);
});
