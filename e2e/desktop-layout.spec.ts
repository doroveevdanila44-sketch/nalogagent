import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';

// палитра «Озеро и зелень» в виде, который отдаёт браузер
const WINE = 'rgb(120, 66, 68)'; // #784244
const WINE_HOVER = 'rgb(138, 79, 82)'; // #8A4F52
const CREAM = 'rgb(255, 248, 224)'; // #FFF8E0
const SOFT = 'rgb(255, 248, 214)'; // #FFF8D6
const LINE = 'rgb(231, 229, 211)'; // #E7E5D3
const LAKE = 'rgb(160, 210, 168)'; // #A0D2A8
const INK = 'rgb(42, 43, 20)'; // #2A2B14
const WHITE = 'rgb(255, 255, 255)';

test.describe.configure({ mode: 'serial' });

async function go(page: Page, tab: 'Агент' | 'Дашборд' | 'Документы') {
  await page.getByRole('link', { name: tab, exact: true }).click();
  const path = { Агент: 'agent', Дашборд: 'dashboard', Документы: 'documents' }[tab];
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/${path}`);
}

const rect = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);

const css = (page: Page, selector: string, prop: string) =>
  page.locator(selector).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

/** Цвет из getComputedStyle: rgb(r, g, b) или color(srgb r g b) у смесей color-mix, каналы 0..255. */
function channels(c: string): [number, number, number] {
  const n = (c.match(/-?\d*\.?\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
  return c.startsWith('color(') ? [n[0] * 255, n[1] * 255, n[2] * 255] : n;
}

/** Контраст двух цветов по WCAG. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = channels(c);
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ===== раскладка от 760 px =====

for (const width of [1440, 1024]) {
  test(`Раскладка ${width} px: панель на всю высоту от верха, шапка правее панели, поля контента равны`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await firstLogin(page, PIN);

    for (const tab of ['Агент', 'Дашборд', 'Документы'] as const) {
      await go(page, tab);
      await expect(page.locator('nav.tabs')).toBeVisible();
      const vh = 900;

      // боковая панель: 96 px, от самого верха на всю высоту окна, фон палитры
      const tabs = (await rect(page, 'nav.tabs'))!;
      expect(tabs.left, `${tab}: панель слева`).toBe(0);
      expect(tabs.top, `${tab}: панель от самого верха`).toBe(0);
      expect(tabs.width).toBe(96);
      expect(tabs.height).toBe(vh);
      expect(await css(page, 'nav.tabs', 'background-color')).toBe(INK);

      // шапка: от правого края панели до правого края окна, не на всю ширину
      const top = (await rect(page, 'header.top'))!;
      expect(top.left, `${tab}: шапка начинается у правого края панели`).toBe(96);
      expect(top.right).toBe(width);
      expect(top.top).toBe(0);
      expect(await css(page, 'header.top', 'background-color')).toBe(LAKE);

      // знак по центру шапки, метка слева сразу правее панели, меню у правого края с отступом 16 px
      const mark = (await rect(page, 'header.top .wordmark'))!;
      expect(Math.abs((mark.left + mark.right) / 2 - (96 + width) / 2)).toBeLessThanOrEqual(2);
      const badge = (await rect(page, '[data-testid="demo-badge"]'))!;
      expect(badge.left - 96).toBeGreaterThanOrEqual(8);
      expect(badge.left - 96).toBeLessThanOrEqual(24);
      const menu = (await rect(page, '.top-actions .icon-btn'))!;
      expect(width - menu.right).toBe(16);

      // первая вкладка на уровне шапки, на высоте строки с меткой «Демо-данные»
      const first = (await rect(page, 'nav.tabs .tab'))!;
      expect(first.top).toBeLessThan(top.height);
      expect(badge.top + badge.height / 2).toBeGreaterThan(first.top);
      expect(badge.top + badge.height / 2).toBeLessThan(first.bottom);

      // контент правее панели, поля слева и справа одинаковые: 24 px, от 1280 px 32 px
      const pad = width >= 1280 ? 32 : 24;
      const main = await page.evaluate(() => {
        const m = document.querySelector('.app-main')!;
        const r = m.getBoundingClientRect();
        const cs = getComputedStyle(m);
        return { left: r.left, right: r.right, pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight) };
      });
      expect(main.left).toBe(96);
      expect(main.right).toBe(width);
      expect(main.pl).toBe(pad);
      expect(main.pr).toBe(pad);

      // ничего не уезжает за окно
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        `${tab}: горизонтальная прокрутка`,
      ).toBeLessThanOrEqual(0);
    }
  });
}

test('Телефон 390 px: прежняя раскладка, шапка на всю ширину, панель внизу', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  for (const tab of ['Агент', 'Дашборд', 'Документы'] as const) {
    await go(page, tab);
    const top = (await rect(page, 'header.top'))!;
    expect(top.left).toBe(0);
    expect(top.right).toBe(390);
    const tabs = (await rect(page, 'nav.tabs'))!;
    expect(tabs.left).toBe(0);
    expect(tabs.right).toBe(390);
    expect(tabs.bottom).toBe(844);
    expect(tabs.height).toBeLessThan(100);
    const main = await page.evaluate(() => {
      const m = document.querySelector('.app-main')!;
      const r = m.getBoundingClientRect();
      return { left: r.left, right: r.right, pl: parseFloat(getComputedStyle(m).paddingLeft) };
    });
    expect(main.left).toBe(0);
    expect(main.right).toBe(390);
    expect(main.pl).toBe(16);
    expect(await css(page, 'nav.tabs', 'background-color')).toBe(INK);
  }
});

// ===== чат на компьютере =====

for (const width of [1440, 1024]) {
  test(`Чат ${width} px: список на всю ширину, пузыри целиком в окне, отступы равны, поле выровнено`, async ({ page }) => {
    await resetChat();
    await page.setViewportSize({ width, height: 900 });
    await firstLogin(page, PIN);

    const input = page.getByLabel('Вопрос агенту');
    const ask = async (text: string) => {
      await input.fill(text);
      await input.press('Enter');
      await expect(page.locator('.typing')).toHaveCount(0);
    };
    await ask('НДС по Альфе за февраль');
    await ask(
      'Что лучше для Беты: пять или семь процентов, если у нас очень длинный вопрос с несколькими обстоятельствами и уточнениями по периоду и по юрлицам группы',
    );
    // слово без пробелов не должно распирать пузырь
    await ask('Ы'.repeat(220));
    await expect(page.locator('.msg.me')).toHaveCount(3);

    const pad = width >= 1280 ? 32 : 24;
    const g = await page.evaluate(() => {
      const r = (e: Element | null) => {
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { left: b.left, right: b.right, width: b.width };
      };
      const list = document.querySelector('.chat-scroll')!;
      return {
        vw: window.innerWidth,
        list: r(list),
        gutter: getComputedStyle(list).getPropertyValue('scrollbar-gutter'),
        overX: list.scrollWidth - list.clientWidth,
        me: [...document.querySelectorAll('.msg.me')].map((e) => ({ ...r(e)!, maxW: getComputedStyle(e).maxWidth, wrap: getComputedStyle(e).overflowWrap })),
        agent: [...document.querySelectorAll('.msg:not(.me)')].map((e) => r(e)!),
        handle: r(document.querySelector('.sug-handle')),
        sug: r(document.querySelector('.sug')),
        composer: r(document.querySelector('.composer')),
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    const list = g.list!;

    // список занимает всю ширину контентной области; левый и правый отступы равны
    expect(list.left, 'отступ слева').toBe(96 + pad);
    expect(g.vw - list.right, 'отступ справа').toBe(pad);
    expect(list.left - 96).toBe(g.vw - list.right);
    expect(g.gutter).toBe('stable both-edges');
    expect(g.overX).toBeLessThanOrEqual(0);
    expect(g.page).toBeLessThanOrEqual(0);

    // реплики пользователя прижаты вправо, целиком в окне, не шире 720 px и 80%
    expect(g.me.length).toBe(3);
    for (const m of g.me) {
      expect(m.right).toBeLessThanOrEqual(list.right + 0.5);
      expect(m.right).toBeGreaterThanOrEqual(list.right - 1);
      expect(m.left).toBeGreaterThanOrEqual(list.left);
      expect(m.right).toBeLessThanOrEqual(g.vw);
      expect(m.width).toBeLessThanOrEqual(Math.min(720, list.width * 0.8) + 0.5);
      expect(m.wrap).toBe('anywhere');
    }
    // ответы агента слева с тем же отступом
    for (const m of g.agent) {
      expect(m.left).toBeCloseTo(list.left, 0);
      expect(m.right).toBeLessThanOrEqual(list.right + 0.5);
      expect(m.width).toBeLessThanOrEqual(Math.min(720, list.width * 0.8) + 0.5);
    }
    // ручка, подсказки и поле ввода по ширине списка
    for (const el of [g.handle, g.sug, g.composer]) {
      expect(el).not.toBeNull();
      expect(el!.left).toBeCloseTo(list.left, 0);
      expect(el!.right).toBeCloseTo(list.right, 0);
    }
  });
}

// ===== цвета баннеров группы =====

for (const width of [1440, 1024, 390]) {
  test(`Баннеры группы: цвета четырёх, раскрытая часть в цветах баннера, ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await go(page, 'Дашборд');
    await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();

    const card = (id: string) => page.locator(`#sum-btn-${id}`);
    const look = (id: string) =>
      card(id).evaluate((e) => {
        const cs = getComputedStyle(e);
        const v = getComputedStyle(e.querySelector('.sum-value')!);
        const l = getComputedStyle(e.querySelector('.sum-label')!);
        return { bg: cs.backgroundColor, color: cs.color, value: v.color, label: l.color, border: cs.borderTopColor, borderW: cs.borderTopWidth };
      });

    // «Выручка с начала года» и «НДС начислен»: #784244, текст #FFF8E0
    for (const id of ['revenue', 'vat']) {
      const c = await look(id);
      expect(c.bg, id).toBe(WINE);
      expect(c.color, id).toBe(CREAM);
      expect(c.value, id).toBe(CREAM);
    }
    // «НДС за 2026 год»: бежевый #FFF8D6, обводка #E7E5D3, значение и подпись #784244
    const soft = await look('vatForecast');
    expect(soft.bg).toBe(SOFT);
    expect(soft.border).toBe(LINE);
    expect(soft.borderW).toBe('1px');
    expect(soft.value).toBe(WINE);
    expect(soft.label).toBe(WINE);
    // «Налог на прибыль за 2026 год»: мятный #A0D2A8, тёмный текст
    const lake = await look('profit');
    expect(lake.bg).toBe(LAKE);
    expect(lake.value).toBe(INK);
    expect(lake.label).toBe(INK);
    // контраст не ниже 4,5:1
    expect(contrast(soft.value, soft.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lake.value, lake.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(CREAM, WINE)).toBeGreaterThanOrEqual(4.5);

    // подписи: переименованы, с отметкой «прогноз», факт плюс остаток из того же расчёта
    await expect(page.getByText('Прогноз НДС за год')).toHaveCount(0);
    await expect(page.getByText('Налог на прибыль: прогноз за год')).toHaveCount(0);
    const vf = card('vatForecast');
    await expect(vf.locator('.sum-label')).toContainText(/НДС за \d{4} год/);
    await expect(vf.locator('.sum-tag')).toHaveText('прогноз');
    const vfSub = (await vf.locator('.sum-sub').innerText()).replace(/\s+/g, ' ');
    const m = /^факт ([\d,]+) млн \+ остаток ([\d,]+) млн$/.exec(vfSub.replace(/[\u00a0\u202f]/g, ' '));
    expect(m, vfSub).not.toBeNull();
    const num = (s: string) => Number(s.replace(',', '.'));
    const total = num(((await vf.locator('.sum-value').innerText()).replace(/[\u00a0\u202f]/g, ' ').match(/[\d,]+/) ?? ['0'])[0]!);
    expect(num(m![1]!) + num(m![2]!)).toBeCloseTo(total, 2);
    const pf = card('profit');
    await expect(pf.locator('.sum-label')).toContainText(/Налог на прибыль за \d{4} год/);
    await expect(pf.locator('.sum-tag')).toHaveText('прогноз');
    const subs = (await pf.locator('.sum-sub').allInnerTexts()).map((t) => t.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' '));
    expect(subs[0]).toMatch(/^Эпсилон, ОСНО: факт [\d,]+ млн \+ остаток [\d,]+ млн$/);
    expect(subs[1]).toMatch(/^УСН по остальным: [\d,]+ млн$/);

    // раскрытая часть каждого баннера в его цветах
    const expected: Record<string, { bg: string; row: 'darker' | 'wine' }> = {
      revenue: { bg: WINE, row: 'wine' },
      vat: { bg: WINE, row: 'wine' },
      vatForecast: { bg: SOFT, row: 'darker' },
      profit: { bg: LAKE, row: 'darker' },
    };
    for (const id of ['revenue', 'vat', 'vatForecast', 'profit']) {
      await card(id).click();
      await page.waitForTimeout(550);
      const open = page.locator(`.sum-detail[data-card="${id}"]`).first();
      await expect(open).toBeVisible();
      const d = await open.evaluate((e) => {
        const cs = getComputedStyle(e);
        const li = e.querySelector('li')!;
        const lcs = getComputedStyle(li);
        return { bg: cs.backgroundColor, color: cs.color, rowBg: lcs.backgroundColor, rowColor: lcs.color };
      });
      expect(d.bg, `${id}: фон`).toBe(expected[id]!.bg);
      if (expected[id]!.row === 'wine') {
        expect(d.color).toBe(CREAM);
        expect(d.rowColor).toBe(CREAM);
      } else {
        // строки на тон темнее фона, текст тёмный, контраст не ниже 4,5:1
        expect(d.color).toBe(INK);
        expect(d.rowColor).toBe(INK);
        expect(d.rowBg).not.toBe(d.bg);
        expect(contrast(d.rowColor, d.rowBg), `${id}: контраст строк`).toBeGreaterThanOrEqual(4.5);
        const sum = (c: string) => channels(c).reduce((a, b) => a + b, 0);
        expect(sum(d.rowBg), `${id}: строка темнее фона`).toBeLessThan(sum(d.bg));
      }
      if (id === 'vatForecast' || id === 'profit') {
        // разбивка по юрлицам и по месяцам с пометками
        const months = open.locator('.bd-months li');
        await expect(months).toHaveCount(12);
        const pills = await months.locator('.bd-pill').allInnerTexts();
        expect(pills).toContain('факт');
        expect(pills).toContain('прогноз');
        expect(new Set(pills).size).toBeGreaterThanOrEqual(2);
        expect(await open.locator('ul.sum-rows li').count()).toBeGreaterThanOrEqual(5);
        await expect(open.locator('[data-testid="row-note"]').first()).toContainText(/факт [\d,]+\s*млн \+ остаток [\d,]+\s*млн/);
      }
    }
  });
}

// ===== выбранное состояние переключателей и основные кнопки =====

test('Переключатели и фильтры: выбранное бордовое, невыбранные белые с обводкой', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await go(page, 'Документы');

  const state = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor };
    });

  // вкладки «Каталог шаблонов» и «Мои документы»
  const catalog = page.getByRole('tab', { name: 'Каталог шаблонов' });
  const mine = page.getByRole('tab', { name: /Мои документы/ });
  expect(await state(catalog)).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(mine)).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  await mine.click();
  expect(await state(mine)).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(catalog)).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  await catalog.click();

  // фильтры каталога
  const all = page.getByRole('group', { name: 'Категория' }).getByRole('button', { name: 'Все', exact: true });
  const contracts = page.getByRole('group', { name: 'Категория' }).getByRole('button', { name: 'Договоры', exact: true });
  expect(await state(all)).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(contracts)).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  await contracts.click();
  expect(await state(contracts)).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(all)).toMatchObject({ bg: WHITE, color: INK, border: LINE });

  // основная кнопка «Заполнить»: бордо, светлый текст, наведение #8A4F52, нажатие 0,97
  const fill = page.locator('li.tpl [data-action="fill"]').first();
  expect(await state(fill)).toMatchObject({ bg: WINE, color: CREAM });
  await fill.hover();
  await expect.poll(async () => (await state(fill)).bg).toBe(WINE_HOVER);
  await page.mouse.down();
  await expect.poll(() => fill.evaluate((e) => getComputedStyle(e).transform)).toBe('matrix(0.97, 0, 0, 0.97, 0, 0)');
  // отпускаем вне кнопки: окно «Заполнить» не открывается
  await page.mouse.move(700, 700);
  await page.mouse.up();

  // выбор налога в расчётах: окно «Показать расчёт» у баннера прибыли (два налога)
  await go(page, 'Дашборд');
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.locator('#sum-btn-profit').click();
  await page.waitForTimeout(600);
  const calcBtn = page.locator('#sum-panel [data-action="calc"]');
  expect(await state(calcBtn)).toMatchObject({ bg: WINE });
  await calcBtn.click();
  const drawer = page.getByTestId('overlay-drawer');
  await expect(drawer).toBeVisible();
  const tabs = drawer.locator('.calc-tab');
  await expect(tabs).toHaveCount(2);
  expect(await state(tabs.nth(0))).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(tabs.nth(1))).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  await tabs.nth(1).click();
  expect(await state(tabs.nth(1))).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(tabs.nth(0))).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  // «Выгрузить в Excel» и другие кнопки окна: бордо
  const excel = drawer.getByRole('button', { name: 'Выгрузить в Excel' });
  expect(await state(excel)).toMatchObject({ bg: WINE, color: CREAM });
  await page.keyboard.press('Escape');

  // карточки ставок не менялись: зелёная и красная
  await expect(page.locator('.rate.sel').first()).toBeVisible();
  expect((await state(page.locator('.rate.sel').first())).bg).toBe('rgb(227, 243, 234)');
  expect((await state(page.locator('.rate.alt').first())).bg).toBe('rgb(252, 234, 231)');
});

test('Быстрые ответы: выбранный вариант бордовый, остальные белые', async ({ page }) => {
  await resetChat();
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  const input = page.getByLabel('Вопрос агенту');
  await input.fill('НДС по Альфе за февраль');
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
  await page.getByRole('button', { name: 'Изменить' }).last().click();
  const panel = page.getByRole('group', { name: 'Варианты уточнения' });
  await expect(panel).toBeVisible();
  const state = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor };
    });
  const vat = panel.getByRole('button', { name: 'НДС', exact: true });
  const usn = panel.getByRole('button', { name: 'УСН', exact: true });
  await expect(vat).toHaveAttribute('aria-pressed', 'true');
  await expect(usn).toHaveAttribute('aria-pressed', 'false');
  expect(await state(vat)).toMatchObject({ bg: WINE, color: CREAM });
  expect(await state(usn)).toMatchObject({ bg: WHITE, color: INK, border: LINE });
  // юрлицо и период тоже выбраны так, как поняты
  await expect(panel.getByRole('button', { name: 'Альфа', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: 'Бета', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
