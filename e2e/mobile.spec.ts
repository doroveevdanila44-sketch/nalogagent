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

test('Телефон 390: в пустом чате подсказки открыты, после выбора свёрнуты и раскрываются нажатием на ручку, рядами высотой 36 с зазором 8, без горизонтальной прокрутки', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);
  await field(page).waitFor();

  const handle = page.locator('.sug-handle');
  const panel = page.locator('#chat-suggestions');

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

  // пустая история: подсказок по центру списка нет, панель открыта по умолчанию, ручка остаётся
  await expect(page.locator('.chat-empty')).toHaveCount(0);
  await expect(handle).toBeVisible();
  await expect(handle).toHaveText('Подсказки');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  expect((await handle.boundingBox())!.height).toBe(28);
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThan(70);
  expect(await panel.locator(':scope > div').evaluate((e) => e.hasAttribute('inert'))).toBe(false);

  // первыми две «Что если» на светлом янтарном фоне, остальные бордовые
  const chips = await page.locator('#chat-suggestions .sug button').evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent, bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color })),
  );
  expect(chips.map((c) => c.text)).toEqual([
    'Что если купим 5 машин?',
    'Что если выручка вырастет на 20%?',
    'Какая ставка выгоднее?',
    'Сколько платить за квартал?',
    'Что с порогами?',
    'Налог на прибыль за год?',
  ]);
  expect(chips[0]!.bg).toBe('rgb(255, 230, 168)'); // #FFE6A8
  expect(chips[1]!.bg).toBe('rgb(255, 230, 168)');
  expect(chips[0]!.color).toBe('rgb(42, 43, 20)'); // #2A2B14
  for (const c of chips.slice(2)) expect(c.bg).toBe('rgb(120, 66, 68)'); // #784244

  // подсказки рядами по 36 px, зазор 8, внутри экрана
  const first = await measure('#chat-suggestions .sug');
  expect(first.count).toBe(6);
  expect(first.flexWrap).toBe('wrap');
  expect(first.overflowX).toBe('visible');
  expect(first.scrolls).toBe(false);
  expect(first.heights).toEqual([36, 36, 36, 36, 36, 36]);
  expect(first.clipped).toBe(false);
  expect(first.inside).toBe(true);
  expect(first.pageScrollX).toBeLessThanOrEqual(0);
  expect(first.rows).toBeGreaterThanOrEqual(2);
  expect(first.gap).toBe('8px 8px');
  for (const g of first.sameRowGaps) expect(g).toBeCloseTo(8, 0);
  for (const g of first.rowGaps) expect(g).toBeCloseTo(8, 0);

  // выбор подсказки отправляет вопрос и сворачивает блок
  await page.getByRole('button', { name: 'Что с порогами?' }).first().tap();
  await expect(page.locator('.msg:not(.me)').last()).toBeVisible();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeLessThan(1);

  // ответ агента блок не раскрыл; ручка раскрывает его снова, ряды те же
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThan(70);
  const docked = await measure('.composer-wrap .sug');
  expect(docked.count).toBe(6);
  expect(docked.flexWrap).toBe('wrap');
  expect(docked.scrolls).toBe(false);
  expect(docked.heights).toEqual([36, 36, 36, 36, 36, 36]);
  expect(docked.clipped).toBe(false);
  expect(docked.inside).toBe(true);
  expect(docked.pageScrollX).toBeLessThanOrEqual(0);
  expect(docked.rows).toBeGreaterThanOrEqual(2);
  for (const g of docked.rowGaps) expect(g).toBeCloseTo(8, 0);
  // повторное нажатие на ручку сворачивает
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
});

test('Телефон 390: подсказки не раскрываются ни прокруткой, ни закрытием клавиатуры, ни новым ответом, поле остаётся в фокусе', async ({
  page,
}) => {
  await resetChat();
  await firstLogin(page, PIN);
  await field(page).waitFor();

  const list = page.locator('.chat-scroll');
  const handle = page.locator('.sug-handle');
  const panel = page.locator('#chat-suggestions');
  const tabs = page.locator('nav.tabs');
  const panelHeight = async () => (await panel.boundingBox())?.height ?? 0;

  // несколько ответов, чтобы список прокручивался; подсказки выбираются через ручку
  for (const q of ['Что с порогами?', 'Какая ставка выгоднее?', 'Налог на прибыль за год?']) {
    // в пустом чате панель открыта по умолчанию, после первого ответа свёрнута
    if ((await handle.getAttribute('aria-expanded')) !== 'true') await handle.tap();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: q }).first().tap();
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(page.locator('.msg:not(.me)').last()).toBeVisible();
    // после выбора блок свёрнут, новый ответ его не раскрыл
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
  }
  await expect.poll(panelHeight).toBeLessThan(1);

  const scrollState = () =>
    page.evaluate(() => {
      const el = document.querySelector('.chat-scroll') as HTMLElement;
      return {
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        winY: window.scrollY,
        docTop: document.scrollingElement!.scrollTop,
        active: document.activeElement?.tagName ?? null,
      };
    });

  // раскладка: страница не прокручивается, прокручивается только список
  const layout = await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll') as HTMLElement;
    const c = getComputedStyle(el);
    return {
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      overflowY: c.overflowY,
      overscroll: c.overscrollBehaviorY,
      minHeight: c.minHeight,
      flex: c.flexGrow,
      rootH: document.querySelector('.chat-root')!.getBoundingClientRect().height,
      docH: document.documentElement.scrollHeight,
      vh: window.innerHeight,
      scrollable: el.scrollHeight > el.clientHeight,
    };
  });
  expect(layout.htmlOverflow).toBe('hidden');
  expect(layout.bodyOverflow).toBe('hidden');
  expect(layout.overflowY).toBe('auto');
  expect(layout.overscroll).toBe('contain');
  expect(layout.flex).toBe('1');
  expect(layout.docH).toBeLessThanOrEqual(layout.vh); // страница целиком на экране
  expect(layout.scrollable).toBe(true);

  // свёрнуто по умолчанию: ручка 28 px; раскрытые подсказки в цвет экрана PIN
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(handle).toHaveAttribute('aria-controls', 'chat-suggestions');
  await expect(handle).toHaveText('Подсказки');
  expect((await handle.boundingBox())!.height).toBe(28);
  await handle.tap();
  await expect.poll(panelHeight).toBeGreaterThan(70);
  const chip = await page.locator('#chat-suggestions .sug button:not(.sug-whatif)').first().evaluate((e) => {
    const c = getComputedStyle(e);
    return {
      bg: c.backgroundColor,
      color: c.color,
      border: c.borderTopColor,
      radius: c.borderTopLeftRadius,
      h: e.getBoundingClientRect().height,
    };
  });
  expect(chip.bg).toBe('rgb(120, 66, 68)'); // #784244
  expect(chip.color).toBe('rgb(255, 248, 224)'); // #FFF8E0
  expect(chip.border).toBe('rgba(255, 255, 255, 0.2)');
  expect(chip.radius).toBe('999px');
  expect(chip.h).toBe(36);
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(400);

  // фокус в поле: клавиатура открылась, блок остался свёрнутым, поле в фокусе
  await field(page).focus();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  expect(await panel.locator(':scope > div').evaluate((e) => e.hasAttribute('inert'))).toBe(true);
  expect((await handle.boundingBox())!.height).toBe(28); // ручка остаётся

  // клавиатура открылась (вьюпорт ниже на 300 px): нижняя панель скрыта, поле над клавиатурой
  await page.setViewportSize({ width: 390, height: 544 });
  await expect(page.locator('html[data-kb="open"]')).toHaveCount(1);
  await expect(tabs).toBeHidden();
  const geo = await page.evaluate(() => {
    const comp = document.querySelector('.composer-wrap')!.getBoundingClientRect();
    const msgs = [...document.querySelectorAll('.msg')];
    const last = msgs[msgs.length - 1]!.getBoundingClientRect();
    const sc = document.querySelector('.chat-scroll')!.getBoundingClientRect();
    return { compBottom: comp.bottom, compTop: comp.top, vh: window.innerHeight, lastBottom: last.bottom, scBottom: sc.bottom };
  });
  expect(Math.abs(geo.compBottom - geo.vh)).toBeLessThanOrEqual(1); // вплотную к клавиатуре
  expect(geo.lastBottom).toBeLessThanOrEqual(geo.compTop + 0.5); // последнее сообщение над полем
  expect(geo.lastBottom).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');

  // список листается жестом, пока клавиатура открыта: страница на месте, поле в фокусе, подсказки свёрнуты
  const atBottom = await scrollState();
  expect(atBottom.max).toBeGreaterThan(200);
  expect(atBottom.max - atBottom.top).toBeLessThan(4); // остался внизу
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await scrollState()).top).toBeLessThan(atBottom.top - 200);
  const scrolled = await scrollState();
  expect(scrolled.winY).toBe(0);
  expect(scrolled.docTop).toBe(0);
  expect(scrolled.active).toBe('TEXTAREA');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  expect((await scrollState()).active).toBe('TEXTAREA');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');

  // нажатие на сообщение и на пустое место не снимает фокус
  await page.locator('.msg').first().dispatchEvent('mousedown');
  await page.mouse.click(box.x + 4, box.y + 4);
  expect((await scrollState()).active).toBe('TEXTAREA');

  // ручка разворачивает блок, фокус и клавиатура остаются; повторное нажатие сворачивает
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThan(60);
  expect((await scrollState()).active).toBe('TEXTAREA');
  await handle.tap();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');

  // клавиатура закрылась: подсказки остались свёрнутыми, нижняя панель вернулась
  await page.setViewportSize({ width: 390, height: 844 });
  await field(page).evaluate((e) => (e as HTMLElement).blur());
  await expect(page.locator('html[data-kb="open"]')).toHaveCount(0);
  await expect(tabs).toBeVisible();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(panelHeight).toBeLessThan(1);

  // клавиатура закрыта: листание вниз и вверх подсказки не раскрывает
  const box2 = (await list.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(100);
  await page.mouse.wheel(0, 200);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(500);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.wheel(0, -200);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(panelHeight).toBeLessThan(1);

  // новый ответ агента на вопрос из поля: блок по-прежнему свёрнут
  await field(page).fill('Что с порогами?');
  await page.getByRole('button', { name: 'Отправить' }).tap();
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(panelHeight).toBeLessThan(1);
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

  test('Подсказки: наведение и нажатие светлее бордо, нажатие уменьшает до 0,97', async ({ page }) => {
    await resetChat();
    await firstLogin(page, PIN);
    await field(page).waitFor();
    await page.getByRole('button', { name: 'Что с порогами?' }).first().click();
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(page.locator('.msg:not(.me)').last()).toBeVisible();

    const chip = page.locator('#chat-suggestions .sug button').nth(1);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    const bg = () => chip.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await bg()).toBe('rgb(120, 66, 68)'); // #784244
    await chip.hover();
    await expect.poll(bg).toBe('rgb(138, 79, 82)'); // #8A4F52

    // нажатие: фон тот же, лёгкое уменьшение до 0,97
    await page.mouse.down();
    await page.waitForTimeout(250);
    const pressed = await chip.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, t: getComputedStyle(e).transform }));
    expect(pressed.bg).toBe('rgb(138, 79, 82)');
    expect(pressed.t).toMatch(/^matrix\(0\.97/);
    await page.mouse.up();
  });
});
