import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

// Телефон: ширина 390, касание. Тот же Chrome, что у остальных сценариев.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const field = (page: Page) => page.getByLabel('Вопрос агенту');

const fieldBox = (page: Page) =>
  field(page).evaluate((e) => {
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);
    return {
      h: r.height,
      bottom: r.bottom,
      overflowY: c.overflowY,
      scrollable: e.scrollHeight > e.clientHeight,
    };
  });

const sendButtonBox = (page: Page) =>
  page.getByRole('button', { name: 'Отправить' }).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { h: r.height, bottom: r.bottom };
  });

const lines = (n: number) => Array.from({ length: n }, (_, i) => `строка ${i + 1}`).join('\n');

test('Телефон 390: в PIN нет «Войти по паролю», «Удалить» стирает по одной цифре', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();
  expect(page.viewportSize()?.width).toBe(390);

  await expect(page.getByRole('button', { name: 'Войти по паролю' })).toHaveCount(0);
  await expect(page.locator('.pin-action.left button')).toHaveCount(0);
  // пока цифр нет, единственная кнопка внизу «Отмена»
  await expect(page.locator('.pin-actions button')).toHaveText(['Отмена']);

  for (const d of ['1', '3', '5']) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(3);
  await expect(page.locator('.pin-actions button')).toHaveText(['Удалить']);

  // каждое нажатие стирает ровно одну последнюю цифру
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(2);
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(1);
  expect(await page.locator('.pin-dots i').first().evaluate((e) => getComputedStyle(e).transitionDuration)).toBe(
    '0.15s',
  );
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(0);
  await expect(page.locator('.pin-actions button')).toHaveText(['Отмена']);

  // опечатка в третьей цифре: после «Удалить» набор продолжается с той же точки, а не с нуля
  for (const d of ['8', '2', '5']) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(2);
  for (const d of ['4', '6']) await page.getByRole('button', { name: d, exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
});

test('Телефон 390: поле чата растёт до шести строк, Enter переносит строку, фокус остаётся после отправки', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);
  await field(page).waitFor();

  // телефон определяется по касанию: Enter не отправляет
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const one = await fieldBox(page);
  expect(one.h).toBe(38);
  expect(one.overflowY).toBe('hidden');

  // поле это textarea, у чата нет form и нет других полей ввода
  expect(await field(page).evaluate((e) => e.tagName)).toBe('TEXTAREA');
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('input, textarea, select')).toHaveCount(1);
  expect(
    await field(page).evaluate((e) => ({
      hint: e.getAttribute('enterkeyhint'),
      ac: e.getAttribute('autocomplete'),
      acorrect: e.getAttribute('autocorrect'),
      acap: e.getAttribute('autocapitalize'),
      spell: (e as HTMLTextAreaElement).spellcheck,
    })),
  ).toEqual({ hint: 'send', ac: 'off', acorrect: 'off', acap: 'sentences', spell: false });
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain(
    'interactive-widget=resizes-content',
  );

  await field(page).click();
  const sendBefore = await sendButtonBox(page);

  // Enter ставит перенос, ничего не отправляется; высота растёт на строку
  await field(page).fill('Первая строка');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Вторая строка');
  expect(await field(page).inputValue()).toBe('Первая строка\nВторая строка');
  await expect(page.locator('.msg.me')).toHaveCount(0);
  const two = await fieldBox(page);
  expect(two.h).toBe(60);

  // три, шесть строк: растёт; кнопка не растёт и остаётся прижатой к низу поля
  await field(page).fill(lines(3));
  expect((await fieldBox(page)).h).toBe(82);
  await field(page).fill(lines(6));
  const six = await fieldBox(page);
  expect(six.h).toBe(148);
  expect(six.scrollable).toBe(false);

  // седьмая строка и дальше: потолок, внутри прокрутка
  await field(page).fill(lines(12));
  const many = await fieldBox(page);
  expect(many.h).toBe(148);
  expect(many.overflowY).toBe('auto');
  expect(many.scrollable).toBe(true);

  const sendMany = await sendButtonBox(page);
  expect(sendMany.h).toBe(sendBefore.h);
  expect(Math.abs(sendMany.bottom - many.bottom)).toBeLessThanOrEqual(0.5);

  // отправка кнопкой: поле возвращается к 38 px, фокус остаётся, текст ушёл целиком
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(field(page)).toHaveValue('');
  expect((await fieldBox(page)).h).toBe(38);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await expect(page.locator('.msg.me').first()).toContainText('строка 1');
  await expect(page.locator('.typing')).toHaveCount(0);
  expect(await page.locator('.msg.me').first().evaluate((e) => (e.textContent ?? '').split('строка').length - 1)).toBe(12);
});

test('Телефон 390: подсказки переносятся рядами, высота 36, зазор 8, без горизонтальной прокрутки', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);
  await field(page).waitFor();

  const measure = async (selector: string) =>
    page.evaluate((sel) => {
      const box = document.querySelector(sel) as HTMLElement;
      const style = getComputedStyle(box);
      const items = [...box.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, h: r.height, clipped: b.scrollWidth > b.clientWidth + 1 };
      });
      const rows = [...new Set(items.map((i) => Math.round(i.top)))].length;
      const sameRowGaps: number[] = [];
      const rowGaps: number[] = [];
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1]!;
        const b = items[i]!;
        if (Math.abs(a.top - b.top) < 1) sameRowGaps.push(b.left - a.right);
        else rowGaps.push(b.top - a.bottom);
      }
      return {
        count: items.length,
        rows,
        overflowX: style.overflowX,
        flexWrap: style.flexWrap,
        gap: style.columnGap + ' ' + style.rowGap,
        scrolls: box.scrollWidth > box.clientWidth,
        heights: items.map((i) => i.h),
        clipped: items.some((i) => i.clipped),
        sameRowGaps,
        rowGaps,
        inside: items.every((i) => i.left >= 0 && i.right <= window.innerWidth),
        pageScrollX: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, selector);

  // пустая история: подсказки по центру
  const empty = await measure('.sug');
  expect(empty.count).toBe(4);
  expect(empty.flexWrap).toBe('wrap');
  expect(empty.overflowX).toBe('visible');
  expect(empty.scrolls).toBe(false);
  expect(empty.heights).toEqual([36, 36, 36, 36]);
  expect(empty.clipped).toBe(false);
  expect(empty.inside).toBe(true);
  expect(empty.pageScrollX).toBeLessThanOrEqual(0);
  expect(empty.rows).toBeGreaterThanOrEqual(2);
  expect(empty.gap).toBe('8px 8px');
  for (const g of empty.sameRowGaps) expect(g).toBeCloseTo(8, 0);
  for (const g of empty.rowGaps) expect(g).toBeCloseTo(8, 0);

  // подсказки над полем после первого ответа
  await page.getByRole('button', { name: 'Что с порогами?' }).first().click();
  await expect(page.locator('.msg:not(.me)').last()).toBeVisible();
  await expect(page.locator('.typing')).toHaveCount(0);
  const docked = await measure('.composer-wrap .sug');
  expect(docked.count).toBe(4);
  expect(docked.flexWrap).toBe('wrap');
  expect(docked.overflowX).toBe('visible');
  expect(docked.scrolls).toBe(false);
  expect(docked.heights).toEqual([36, 36, 36, 36]);
  expect(docked.clipped).toBe(false);
  expect(docked.inside).toBe(true);
  expect(docked.pageScrollX).toBeLessThanOrEqual(0);
  expect(docked.rows).toBeGreaterThanOrEqual(2);
  for (const g of docked.rowGaps) expect(g).toBeCloseTo(8, 0);
});

test('Телефон 390: клавиатура прячет нижнюю панель, поле над клавиатурой, последнее сообщение видно', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);
  await field(page).waitFor();

  // несколько ответов, чтобы страница прокручивалась
  for (const q of ['Что с порогами?', 'Какая ставка выгоднее?', 'Налог на прибыль за год?']) {
    await page.getByRole('button', { name: q }).first().click();
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(page.locator('.msg:not(.me)').last()).toBeVisible();
  }

  const tabs = page.locator('nav.tabs');
  await expect(tabs).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.kb ?? null)).toBeNull();

  // клавиатура открывается: фокус в поле и вьюпорт ниже на 300 px (так сжимает его Chrome с resizes-content)
  await field(page).focus();
  await page.setViewportSize({ width: 390, height: 544 });
  await expect(page.locator('html[data-kb="open"]')).toHaveCount(1);
  await expect(tabs).toBeHidden();

  const geo = await page.evaluate(() => {
    const comp = document.querySelector('.composer-wrap')!.getBoundingClientRect();
    const msgs = [...document.querySelectorAll('.msg')];
    const last = msgs[msgs.length - 1]!.getBoundingClientRect();
    return { compBottom: comp.bottom, compTop: comp.top, vh: window.innerHeight, lastBottom: last.bottom, lastTop: last.top };
  });
  // поле стоит вплотную к клавиатуре (низ вьюпорта), зазора нет
  expect(Math.abs(geo.compBottom - geo.vh)).toBeLessThanOrEqual(1);
  // последнее сообщение не закрыто полем
  await expect.poll(() =>
    page.evaluate(() => {
      const comp = document.querySelector('.composer-wrap')!.getBoundingClientRect();
      const msgs = [...document.querySelectorAll('.msg')];
      return msgs[msgs.length - 1]!.getBoundingClientRect().bottom <= comp.top + 0.5;
    }),
  ).toBe(true);

  // поле растёт, сообщение остаётся видно
  await field(page).fill(lines(6));
  await expect.poll(() =>
    page.evaluate(() => {
      const comp = document.querySelector('.composer-wrap')!.getBoundingClientRect();
      const msgs = [...document.querySelectorAll('.msg')];
      const last = msgs[msgs.length - 1]!.getBoundingClientRect();
      return last.bottom <= comp.top + 0.5 && last.bottom > 0;
    }),
  ).toBe(true);

  // клавиатура закрывается: панель возвращается
  await page.setViewportSize({ width: 390, height: 844 });
  await field(page).evaluate((e) => (e as HTMLElement).blur());
  await expect(page.locator('html[data-kb="open"]')).toHaveCount(0);
  await expect(tabs).toBeVisible();
});

test.describe('Компьютер', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('Enter отправляет, Shift+Enter переносит строку, после отправки поле 38 px и фокус в поле', async ({ page }) => {
    await resetChat();
    await firstLogin(page, PIN);
    await field(page).waitFor();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);

    await field(page).click();
    await page.keyboard.type('Первая строка');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Вторая строка');
    expect(await field(page).inputValue()).toBe('Первая строка\nВторая строка');
    await expect(page.locator('.msg.me')).toHaveCount(0);
    expect((await fieldBox(page)).h).toBe(60);

    await page.keyboard.press('Enter');
    await expect(page.locator('.msg.me').first()).toContainText('Первая строка');
    await expect(field(page)).toHaveValue('');
    expect((await fieldBox(page)).h).toBe(38);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    await expect(page.locator('.typing')).toHaveCount(0);

    // кнопка «Отправить» отправляет и на компьютере, фокус остаётся
    await page.keyboard.type('Что с порогами?');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(field(page)).toHaveValue('');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  });
});
