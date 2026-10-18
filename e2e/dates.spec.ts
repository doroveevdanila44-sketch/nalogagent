import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { firstLogin, pickSuggestion, resetChat } from './helpers';

/**
 * Экраны на выбранную дату. Сервер запускается с часами расчётов на заданном моменте:
 *   PW_FAKE_NOW=2026-10-29T00:00:00Z PW_DATE_TAG=oct29 npx playwright test e2e/dates.spec.ts
 * Даты аудита: oct14, oct29, dec20, jan05 (2027). Вход, PIN и сессии идут по настоящему времени.
 * Текст экранов можно сложить в папку DATES_OUT для просмотра глазами.
 */
const FAKE = process.env.PW_FAKE_NOW;
const TAG = process.env.PW_DATE_TAG ?? '';
const OUT = process.env.DATES_OUT;
test.skip(!FAKE, 'нужна PW_FAKE_NOW: сервер запускается с выбранной датой');
test.describe.configure({ mode: 'serial' });

const PIN = '8246';
const BAD = /NaN|undefined|Invalid|\[object|Infinity|null\b/;

function dump(name: string, text: string): void {
  if (!OUT) return;
  fs.mkdirSync(`${OUT}/${TAG}`, { recursive: true });
  fs.writeFileSync(`${OUT}/${TAG}/${name}.txt`, text);
}

const main = (page: Page) => page.locator('main');
const plain = (s: string) => s.replace(/[  ]/g, ' ');

async function open(page: Page, tab: 'Агент' | 'Дашборд' | 'Документы'): Promise<void> {
  await page.getByRole('link', { name: tab, exact: true }).click();
}

/** Ожидаемое «ближайшее» по дате: 28 октября до 28 октября включительно, дальше переход вперёд. */
const EXPECT: Record<string, { banner: RegExp | null; warnPayment: RegExp | null; alfaNext: RegExp | null; betaNext: RegExp | null }> = {
  oct14: { banner: null, warnPayment: /28 октября: авансовые платежи/, alfaNext: /28 октября/, betaNext: /28 октября/ },
  oct29: { banner: null, warnPayment: /28 ноября: вторая треть НДС за 3 квартал/, alfaNext: /28 марта 2027/, betaNext: /28 апреля 2027/ },
  dec20: { banner: null, warnPayment: /28 декабря: третья треть НДС за 3 квартал/, alfaNext: /28 марта 2027/, betaNext: /28 апреля 2027/ },
  jan05: { banner: null, warnPayment: null, alfaNext: null, betaNext: null },
};

test('вход и дашборд на выбранную дату', async ({ page }) => {
  test.setTimeout(120_000);
  await resetChat();
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await open(page, 'Дашборд');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');

  if (TAG === 'jan05') {
    // правил 2027 года в справочнике нет: ясное сообщение и кнопка, а не пустой экран
    const alert = page.locator('main [role="alert"]').first();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Нет правил НДС на текущий год');
    await expect(alert.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
    dump('dashboard', plain(await main(page).innerText()));
    return;
  }

  await expect(page.locator('[data-tour="banner-vat-forecast"] .sum-value')).toBeVisible();
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  const text = plain(await main(page).innerText());
  dump('dashboard', text);
  expect(text).not.toMatch(BAD);
  const exp = EXPECT[TAG]!;
  if (exp.warnPayment) expect(text).toMatch(exp.warnPayment);
  // пять карточек юрлиц, у каждой «Ближайший платёж» с датой, которая не в прошлом
  const cards = page.locator('.ent');
  await expect(cards).toHaveCount(5);
  const nexts = await cards.evaluateAll((els) =>
    els.map((e) => ({
      name: e.querySelector('h3')?.textContent ?? '',
      next: (e.querySelector('.taxblock dd.wide, .taxblock .wide dd') as HTMLElement | null)?.innerText ?? '',
    })),
  );
  for (const n of nexts) expect(n.next, n.name).not.toBe('');
  const byName = (s: string) => plain(nexts.find((n) => n.name.includes(s))!.next);
  if (exp.alfaNext) expect(byName('Альфа')).toMatch(exp.alfaNext);
  if (exp.betaNext) expect(byName('Бета')).toMatch(exp.betaNext);
  // подписи месяцев на графике: прошедший месяц без факта не «факт»
  const labels = await page.locator('.col').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  expect(labels.length).toBe(12);
  dump('chart-labels', labels.join('\n'));
  if (TAG === 'dec20') {
    expect(labels[9]).toContain('прогноз'); // октябрь: факта нет
    expect(labels[10]).toContain('прогноз'); // ноябрь: факта нет
    expect(labels[8]).toContain('факт'); // сентябрь: факт есть
    expect(labels[11]).toContain('идёт сейчас');
  } else {
    expect(labels[8]).toContain('факт');
    expect(labels[9]).toContain('идёт сейчас');
  }
});

test('агент отвечает на подсказки без ошибок и пустых ответов', async ({ page }) => {
  test.setTimeout(180_000);
  await resetChat();
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  const all: string[] = [];
  for (const q of [
    'Какая ставка выгоднее?',
    'Сколько платить за квартал?',
    'Что с порогами?',
    'Налог на прибыль за год?',
    'Что если выручка вырастет на 20%?',
    'Что если купим 5 машин?',
  ]) {
    await pickSuggestion(page, q);
    await expect(page.locator('.typing')).toHaveCount(0);
    // вопрос про юрлицо: выбираем Дельту, у которой порог и освобождение
    const quick = page.locator('.msg:not(.me)').last().getByRole('button', { name: 'Дельта', exact: true });
    if ((await quick.count()) > 0) {
      await quick.first().click();
      await expect(page.locator('.typing')).toHaveCount(0);
    }
    const last = plain(await page.locator('.msg:not(.me)').last().innerText());
    all.push(`### ${q}\n${last}`);
    expect(last.trim().length, q).toBeGreaterThan(10);
    expect(last, q).not.toMatch(BAD);
    if (TAG === 'jan05') expect(last, q).toContain('Нет правил НДС');
  }
  dump('agent', all.join('\n\n'));
  if (TAG === 'dec20') {
    // в декабре месяцев для сдачи не остаётся: ответ говорит об этом, карточки с пустым списком месяцев нет
    expect(all.join('\n')).toContain('До конца 2026 года месяцев, в которых машины дали бы выручку, не осталось');
    await expect(page.locator('[data-form="fleet"]')).toHaveCount(0);
  }
});

test('документы и «Что проверено» открываются на выбранную дату', async ({ page }) => {
  test.setTimeout(120_000);
  await resetChat();
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await open(page, 'Документы');
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents/);
  await expect(main(page)).not.toBeEmpty();
  await page.waitForTimeout(600);
  const docs = plain(await main(page).innerText());
  dump('documents', docs);
  expect(docs).not.toMatch(BAD);
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Что проверено', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/statuses');
  await page.waitForTimeout(600);
  const st = plain(await main(page).innerText());
  dump('statuses', st);
  expect(st.trim().length).toBeGreaterThan(10);
  expect(st).not.toMatch(BAD);
});
