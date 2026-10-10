import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';
const WINE = 'rgb(120, 66, 68)'; // #784244
const LAKE = 'rgb(160, 210, 168)'; // #A0D2A8

test.describe.configure({ mode: 'serial' });

// Телефон: ширина 390, касание
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const themeColor = (page: Page) => page.locator('meta[name="theme-color"]').first().getAttribute('content');

async function toDashboard(page: Page) {
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
}

/** Дать анимации 450 мс закончиться */
const settle = (page: Page) => page.waitForTimeout(650);

test('Полоса под часами: theme-color бордо на входе и PIN, озеро в приложении, меняется при блокировке', async ({
  page,
}) => {
  await page.goto('/login');
  expect(await themeColor(page)).toBe('#784244');
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  // установленное приложение: страница рисуется под часами
  expect(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute('content')).toBe(
    'black-translucent',
  );

  // фон html и body бордо, полоса под safe-area закрашена тем же цветом
  const login = await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '47px');
    const strip = getComputedStyle(document.querySelector('.auth-screen')!, '::before');
    return {
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      stripBg: strip.backgroundColor,
      stripPos: strip.position,
      stripH: strip.height,
    };
  });
  expect(login).toEqual({ html: WINE, body: WINE, stripBg: WINE, stripPos: 'fixed', stripH: '47px' });

  // экран PIN при создании PIN остаётся бордовым
  await firstLogin(page, PIN);
  expect(new URL(page.url()).pathname).toBe('/agent');
  expect(await themeColor(page)).toBe('#A0D2A8');
  await toDashboard(page);
  expect(await themeColor(page)).toBe('#A0D2A8');

  // блокировка: бордо, разблокировка: озеро
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible();
  expect(await themeColor(page)).toBe('#784244');

  // возврат из фона: система могла сбросить полосу, значение выставляется заново
  await page.evaluate(() => {
    document.querySelector('meta[name="theme-color"]')!.setAttribute('content', '#FFFFFF');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await themeColor(page)).toBe('#784244');

  for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeHidden();
  expect(await themeColor(page)).toBe('#A0D2A8');

  // экран PIN после перезагрузки (маршрут /login): бордо с первого кадра
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();
  expect(await themeColor(page)).toBe('#784244');
  for (const d of PIN) await page.getByRole('button', { name: d, exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  expect(await themeColor(page)).toBe('#A0D2A8');
});

test('Шапка прилипает к верху без отрыва: свой padding-top под safe-area, фон html цвета шапки', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);

  const check = async (label: string) => {
    // как на iPhone с вырезом: безопасная зона сверху 47 px
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-top', '47px'));
    const m = await page.evaluate(() => {
      const top = document.querySelector('.top') as HTMLElement;
      const c = getComputedStyle(top);
      const body = getComputedStyle(document.body);
      return {
        position: c.position,
        top: c.top,
        padTop: c.paddingTop,
        marginTop: c.marginTop,
        height: top.getBoundingClientRect().height,
        bg: c.backgroundColor,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        overscroll: body.overscrollBehaviorY,
        htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
      };
    });
    expect(m.position, label).toBe('sticky');
    expect(m.top, label).toBe('0px');
    expect(m.padTop, label).toBe('47px'); // safe-area один раз, внутри шапки
    expect(m.marginTop, label).toBe('0px');
    expect(m.height, label).toBe(47 + 54); // отступ учтён один раз: 47 + 54, а не 47 + 47 + 54
    expect(m.bg, label).toBe(LAKE);
    expect(m.htmlBg, label).toBe(LAKE);
    expect(m.overscroll, label).toBe('none');
    expect(m.htmlOverscroll, label).toBe('none');

    // при прокрутке шапка остаётся у верхнего края, над ней нет просвета
    for (const y of [150, 600, 5000]) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.querySelector('.top')!.getBoundingClientRect().top), `${label} ${y}`).toBe(0);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  };

  // агент: несколько ответов, чтобы страница прокручивалась
  for (const q of ['Что с порогами?', 'Какая ставка выгоднее?']) {
    await page.getByRole('button', { name: q }).first().click();
    await expect(page.locator('.typing')).toHaveCount(0);
    await expect(page.locator('.msg:not(.me)').last()).toBeVisible();
  }
  await check('агент');
  await toDashboard(page);
  await check('дашборд');
});

test('Баннеры: расшифровка раскрывается под нажатым баннером, остальные съезжают вниз, блока после всех нет', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const geometry = () =>
    page.evaluate(() => {
      const cards = [...document.querySelectorAll('.sum-card')].map((e) => e.getBoundingClientRect());
      const list = document.querySelector('.sum-cards')!.getBoundingClientRect();
      const items = [...document.querySelectorAll('.sum-item')].map((e) => e.getBoundingClientRect());
      return {
        tops: cards.map((r) => Math.round(r.top)),
        bottoms: cards.map((r) => Math.round(r.bottom)),
        listBottom: Math.round(list.bottom),
        itemBottoms: items.map((r) => Math.round(r.bottom)),
        details: [...document.querySelectorAll('.sum-detail')].length,
        oldBlock: document.getElementById('sum-detail') !== null,
        lastItemBottom: Math.round(items[items.length - 1]!.bottom),
      };
    });

  const before = await geometry();
  expect(before.details).toBe(4); // расшифровка принадлежит своей карточке: по одной на каждую
  expect(before.oldBlock).toBe(false); // единого блока после всех баннеров нет
  expect(before.tops.length).toBe(4);

  // нажали второй баннер
  await page.locator('.sum-card').nth(1).click();
  await settle(page);
  const open = await geometry();
  const detail = page.locator('#sum-detail-vat');
  await expect(detail).toBeVisible();
  await expect(page.locator('.sum-card').nth(1)).toHaveAttribute('aria-expanded', 'true');

  // первый и второй на месте, третий и четвёртый ушли вниз на высоту расшифровки
  expect(open.tops[0]).toBe(before.tops[0]);
  expect(open.tops[1]).toBe(before.tops[1]);
  const shift = open.tops[2]! - before.tops[2]!;
  expect(shift).toBeGreaterThan(100);
  expect(Math.abs(open.tops[3]! - before.tops[3]! - shift)).toBeLessThanOrEqual(1); // доли пикселя округляются
  // расшифровка стоит прямо под нажатым баннером и выше третьего
  const box = (await detail.boundingBox())!;
  expect(Math.abs(box.y - open.bottoms[1]!)).toBeLessThanOrEqual(1);
  expect(box.y + box.height).toBeLessThanOrEqual(open.tops[2]! + 1);
  // нет блока после всех баннеров: список заканчивается последним баннером
  expect(Math.abs(open.listBottom - open.lastItemBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(open.listBottom - open.bottoms[3]!)).toBeLessThanOrEqual(1);

  // оформление раскрытой части
  const look = await page.evaluate(() => {
    const d = document.querySelector('#sum-detail-vat .sum-detail')!;
    const li = d.querySelector('li')!;
    const chev = getComputedStyle(document.querySelector('.sum-card.open .sum-chev')!).transform;
    return {
      bg: getComputedStyle(d).backgroundColor,
      color: getComputedStyle(d).color,
      rowBg: getComputedStyle(li).backgroundColor,
      rowColor: getComputedStyle(li).color,
      chev,
      acc: (() => {
        const a = getComputedStyle(document.getElementById('sum-detail-vat')!);
        return { prop: a.transitionProperty, dur: a.transitionDuration, fn: a.transitionTimingFunction };
      })(),
      body: (() => {
        const b = getComputedStyle(d);
        return { dur: b.transitionDuration, fn: b.transitionTimingFunction };
      })(),
    };
  });
  expect(look.bg).toBe(WINE);
  expect(look.color).toBe('rgb(255, 248, 224)'); // #FFF8E0
  expect(look.rowColor).toBe('rgb(255, 248, 224)');
  expect(look.rowBg).not.toBe(WINE); // строки на тон светлее
  const [r, g, b] = look.rowBg.match(/\d+/g)!.map(Number) as [number, number, number];
  expect(r).toBeGreaterThan(120);
  expect(g).toBeGreaterThan(66);
  expect(b).toBeGreaterThan(68);
  expect(look.chev).toMatch(/^matrix\(-1,/); // стрелка повёрнута на 180 градусов
  expect(look.acc).toEqual({
    prop: 'grid-template-rows',
    dur: '0.45s',
    fn: 'cubic-bezier(0.22, 1, 0.36, 1)',
  });
  // содержимое: прозрачность и сдвиг с той же длительностью и кривой
  expect(look.body.dur).toBe('0.45s, 0.45s');
  expect(look.body.fn).toBe('cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1)');

  // открыли третий: второй закрывается одновременно, в середине анимации они оба частично раскрыты
  const h2 = (await page.locator('#sum-detail-vat').boundingBox())!.height;
  await page.locator('.sum-card').nth(2).click();
  await page.waitForTimeout(110);
  const mid = await page.evaluate(() => ({
    closing: document.getElementById('sum-detail-vat')!.getBoundingClientRect().height,
    opening: document.getElementById('sum-detail-vatForecast')!.getBoundingClientRect().height,
  }));
  expect(mid.closing).toBeLessThan(h2);
  expect(mid.closing).toBeGreaterThan(0);
  expect(mid.opening).toBeGreaterThan(0);
  await settle(page);
  await expect(page.locator('.sum-item.open')).toHaveCount(1);
  await expect(page.locator('.sum-card').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sum-detail-vat')).toBeHidden();

  // свёрнутая расшифровка недоступна с клавиатуры
  expect(await page.locator('#sum-detail-vat .acc-in').evaluate((e) => e.hasAttribute('inert'))).toBe(true);

  // повторное нажатие закрывает
  await page.locator('.sum-card').nth(2).click();
  await settle(page);
  await expect(page.locator('.sum-item.open')).toHaveCount(0);
  const closed = await geometry();
  expect(closed.tops).toEqual(before.tops);
});

test('390 px: четыре отдельных баннера группы, широкого баннера нет', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  await expect(page.locator('.sum-card')).toHaveCount(4);
  await expect(page.locator('.band')).toHaveCount(0);
  await expect(page.locator('.metric')).toHaveCount(0);

  const m = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.sum-card')].map((e) => e.getBoundingClientRect());
    const cs = getComputedStyle(document.querySelector('.sum-card')!);
    return {
      lefts: new Set(boxes.map((b) => Math.round(b.left))).size,
      tops: new Set(boxes.map((b) => Math.round(b.top))).size,
      bg: cs.backgroundColor,
      color: cs.color,
      scrollX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(m.lefts).toBe(1); // один столбец
  expect(m.tops).toBe(4); // четыре отдельных баннера друг под другом
  expect(m.bg).toBe(WINE);
  expect(m.color).toBe('rgb(255, 248, 224)');
  expect(m.scrollX).toBeLessThanOrEqual(0);

  // подпись справа от заголовка группы на телефоне под заголовком, раскрытие по месту работает
  await expect(page.locator('.sum-head p')).toHaveText('5 юрлиц · УСН и ОСНО');
  await page.locator('.sum-card').nth(0).click();
  await expect(page.locator('#sum-detail-revenue')).toBeVisible();
});

test('Баннеры: prefers-reduced-motion отключает анимацию раскрытия', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toDashboard(page);
  const dur = await page.locator('#sum-detail-revenue').evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration));
  expect(dur).toBeLessThan(0.01);
  await page.locator('.sum-card').nth(0).click();
  await expect(page.locator('#sum-detail-revenue')).toBeVisible();
});

test('Предупреждения: по умолчанию свёрнуты, раскрываются по строке, можно несколько, цель не меньше 44 px', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const heads = page.locator('.warn-head');
  const count = await heads.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // по умолчанию все свёрнуты: видны заголовок, метка и стрелка, пояснения нет
  for (let i = 0; i < count; i++) {
    await expect(heads.nth(i)).toHaveAttribute('aria-expanded', 'false');
    // свёрнуто: область пояснения имеет нулевую высоту (текст обрезан, а не просто прозрачен)
    await expect(page.locator('li.warn').nth(i).locator('.acc')).toBeHidden();
    await expect(page.locator('li.warn').nth(i).locator('.pill')).toBeVisible();
  }
  await expect(page.locator('li.warn.open')).toHaveCount(0);

  const m = await page.evaluate(() => {
    const items = [...document.querySelectorAll('li.warn')] as HTMLElement[];
    return items.map((li) => {
      const head = li.querySelector('.warn-head') as HTMLElement;
      const title = li.querySelector('.warn-title') as HTMLElement;
      const lh = parseFloat(getComputedStyle(title).lineHeight);
      return {
        headH: head.getBoundingClientRect().height,
        headW: head.getBoundingClientRect().width,
        titleLines: Math.round(title.getBoundingClientRect().height / lh),
        titleLength: (title.textContent ?? '').length,
        clipped: title.scrollWidth > title.clientWidth + 1,
        overflowX: getComputedStyle(title).textOverflow,
        border: getComputedStyle(li).borderBottomWidth,
        controls: head.getAttribute('aria-controls'),
        controlled: document.getElementById(head.getAttribute('aria-controls') ?? '') !== null,
        pill: li.querySelector('.pill')!.textContent,
      };
    });
  });
  for (const w of m) {
    expect(w.headH).toBeGreaterThanOrEqual(44);
    // одна-две строки; три только у заголовка длиннее 90 знаков (текст из калькулятора), и он не обрезан
    expect(w.titleLines).toBeLessThanOrEqual(w.titleLength > 90 ? 3 : 2);
    expect(w.clipped).toBe(false);
    expect(w.overflowX).not.toBe('ellipsis');
    expect(w.border).toBe('1px');
    expect(w.controlled).toBe(true);
  }
  // «Срочно» вверху списка: после первой не срочной срочных нет
  const tags = m.map((w) => w.pill);
  const lastCrit = tags.lastIndexOf('Срочно');
  const firstOther = tags.findIndex((t) => t !== 'Срочно');
  if (lastCrit >= 0 && firstOther >= 0) expect(lastCrit).toBeLessThan(firstOther);
  expect(m.every((w) => w.headW > 300)).toBe(true); // на всю ширину: нажатие по всей строке

  // раскрыть первую: пояснение видно, фон строки темнее, разделитель на месте
  const first = page.locator('li.warn').nth(0);
  const closedBg = await first.evaluate((e) => getComputedStyle(e).backgroundColor);
  await heads.nth(0).click();
  await settle(page);
  await expect(heads.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(first.locator('.warn-text')).toBeVisible();
  const openBg = await first.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(openBg).not.toBe(closedBg);
  expect(await first.evaluate((e) => getComputedStyle(e).borderBottomWidth)).toBe('1px');
  expect(
    await first.locator('.acc').evaluate((e) => {
      const c = getComputedStyle(e);
      return { prop: c.transitionProperty, dur: c.transitionDuration, fn: c.transitionTimingFunction };
    }),
  ).toEqual({ prop: 'grid-template-rows', dur: '0.45s', fn: 'cubic-bezier(0.22, 1, 0.36, 1)' });

  // вторая раскрывается, первая остаётся открытой: открыть можно несколько
  await heads.nth(1).click();
  await settle(page);
  await expect(heads.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(heads.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('li.warn.open')).toHaveCount(2);

  // с клавиатуры: Enter закрывает
  await heads.nth(0).focus();
  await page.keyboard.press('Enter');
  await settle(page);
  await expect(heads.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(first.locator('.acc')).toBeHidden();
  // свёрнутое пояснение недоступно для фокуса
  expect(await first.locator('.acc-in').evaluate((e) => e.hasAttribute('inert'))).toBe(true);
});

test('График: нажатие на подпись месяца выделяет весь столбец, повторное снимает; сегмент выделяется отдельно', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);
  await expect(page.locator('.plot .col')).toHaveCount(12);
  await expect(page.locator('.mon-btn')).toHaveCount(12);

  // подпись месяца и сегмент это кнопки с aria-label
  const label = await page.locator('.mon-btn').nth(7).getAttribute('aria-label');
  expect(label).toMatch(/^Август: .*млн.*Выделить весь столбец$/);
  expect(await page.locator('.mon-btn').nth(7).evaluate((e) => e.tagName)).toBe('BUTTON');
  expect(await page.locator('.col').nth(7).locator('button.seg').first().getAttribute('aria-label')).toMatch(/Август/);

  // по умолчанию ничего не выделено
  await expect(page.locator('.col.sel')).toHaveCount(0);

  // касание пальцем (pointerType touch): наведения при этом нет
  const btn = page.locator('.mon-btn').nth(7);
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  await expect(page.locator('.col.sel')).toHaveCount(1);
  await expect(page.locator('.col').nth(7)).toHaveClass(/sel/);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(450);

  const sel = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.plot .col')] as HTMLElement[];
    const op = (e: Element) => Number(getComputedStyle(e).opacity);
    const selected = cols[7]!;
    return {
      others: cols.filter((_, i) => i !== 7).map(op),
      selOpacity: op(selected),
      selTransform: getComputedStyle(selected).transform,
      segs: [...selected.querySelectorAll('.seg')].map(op),
      singleOn: document.querySelectorAll('.seg.on').length,
      plotCol: document.querySelector('.plot')!.getAttribute('data-col'),
    };
  });
  for (const o of sel.others) expect(o).toBeCloseTo(0.45, 2); // остальные приглушены до 45 процентов
  expect(sel.selOpacity).toBe(1);
  expect(sel.selTransform).not.toBe('none'); // столбец увеличен
  for (const o of sel.segs) expect(o).toBe(1); // все сегменты в полную силу
  expect(sel.singleOn).toBe(0);
  expect(sel.plotCol).toBe('true');

  // подпись: месяц, итог столбца и разбивка по юрлицам
  const card = page.locator('.seg-card');
  await expect(card).toContainText('Август');
  await expect(card.locator('.seg-amount')).toContainText('млн');
  await expect(card.locator('.seg-split li')).toHaveCount(5);
  await expect(card.locator('.seg-split')).toContainText('ООО «Альфа»');

  // повторное нажатие снимает выделение
  await btn.tap();
  await expect(page.locator('.col.sel')).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('.seg-split')).toHaveCount(0);
  expect(await page.locator('.plot').getAttribute('data-col')).toBeNull();

  // нажатие на пустую область над столбцом (касанием) тоже выделяет весь столбец
  const point = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.plot .col')] as HTMLElement[];
    let best = { i: 0, gap: -1, x: 0, y: 0 };
    cols.forEach((col, i) => {
      const r = col.getBoundingClientRect();
      const segs = [...col.querySelectorAll('.seg')].map((s) => s.getBoundingClientRect());
      const topOfStack = Math.min(...segs.map((s) => s.top));
      const gap = topOfStack - r.top;
      if (gap > best.gap) best = { i, gap, x: r.left + r.width / 2, y: r.top + gap / 2 };
    });
    return best;
  });
  expect(point.gap).toBeGreaterThan(20);
  await page.locator('.col').nth(point.i).scrollIntoViewIfNeeded();
  const pt = await page.evaluate((i) => {
    const col = document.querySelectorAll('.plot .col')[i]!;
    const r = col.getBoundingClientRect();
    const segs = [...col.querySelectorAll('.seg')].map((s) => s.getBoundingClientRect());
    const topOfStack = Math.min(...segs.map((s) => s.top));
    return { x: r.left + r.width / 2, y: r.top + (topOfStack - r.top) / 2 };
  }, point.i);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect(page.locator('.col').nth(point.i)).toHaveClass(/sel/);
  await expect(page.locator('.col.sel')).toHaveCount(1);
  await expect(card.locator('.seg-split li')).toHaveCount(5);

  // нажатие на сегмент выделяет только сегмент юрлица, как раньше
  const seg = page.locator('.col').nth(7).locator('button.seg').first();
  await seg.scrollIntoViewIfNeeded();
  await seg.tap();
  await expect(page.locator('.seg.on')).toHaveCount(1);
  await expect(page.locator('.col.sel')).toHaveCount(0);
  await expect(card.locator('.seg-split')).toHaveCount(0);
  await expect(card).toContainText('ООО «Альфа»');
});

test('График: подпись месяца работает с клавиатуры', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const btn = page.locator('.mon-btn').nth(3);
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.col').nth(3)).toHaveClass(/sel/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.mon-btn').nth(4)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.col').nth(4)).toHaveClass(/sel/);
  await expect(page.locator('.col.sel')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.col.sel')).toHaveCount(0);
});

test.describe('Компьютер', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('График: наведение на подпись месяца подсвечивает столбец так же', async ({ page }) => {
    await firstLogin(page, PIN);
    await toDashboard(page);

    const btn = page.locator('.mon-btn').nth(5);
    await btn.scrollIntoViewIfNeeded();
    await btn.hover();
    await expect(page.locator('.col').nth(5)).toHaveClass(/sel/);
    await expect(page.locator('.seg-card .seg-split li')).toHaveCount(5);
    await page.mouse.move(2, 2);
    await expect(page.locator('.col.sel')).toHaveCount(0);

    // наведение на сегмент подсвечивает только сегмент
    const seg = page.locator('.col').nth(5).locator('button.seg').first();
    await seg.hover();
    await expect(page.locator('.seg.on')).toHaveCount(1);
    await expect(page.locator('.col.sel')).toHaveCount(0);
  });

  test('1440 px: один широкий баннер группы, четыре показателя в одном ряду, баннер не раскрывается', async ({
    page,
  }) => {
    await firstLogin(page, PIN);
    await page.setViewportSize({ width: 1440, height: 900 });
    await toDashboard(page);

    // один баннер группы вместо четырёх отдельных
    await expect(page.locator('.band')).toHaveCount(1);
    await expect(page.locator('.sum-card')).toHaveCount(0);
    await expect(page.locator('.sum-cards')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Группа на \d+ \S+ \d{4}$/ })).toHaveCount(1);
    await expect(page.locator('.band-h span')).toHaveText('5 юрлиц · УСН и ОСНО');

    const m = await page.evaluate(() => {
      const band = document.querySelector('.band')!;
      const bandBox = band.getBoundingClientRect();
      const metrics = [...band.querySelectorAll('.metric')] as HTMLElement[];
      const boxes = metrics.map((e) => e.getBoundingClientRect());
      const cs = getComputedStyle(band);
      return {
        labels: metrics.map((e) => e.querySelector('.eyebrow')!.textContent),
        values: metrics.map((e) => e.querySelector('strong')!.textContent),
        tops: boxes.map((b) => Math.round(b.top)),
        lefts: boxes.map((b) => Math.round(b.left)),
        inside: boxes.every((b) => b.left >= bandBox.left && b.right <= bandBox.right),
        valueTops: metrics.map((e) => Math.round(e.querySelector('strong')!.getBoundingClientRect().top)),
        clipped: metrics.some((e) => {
          const v = e.querySelector('strong') as HTMLElement;
          return v.scrollWidth > e.clientWidth;
        }),
        bg: cs.backgroundColor,
        color: cs.color,
        radius: cs.borderTopLeftRadius,
        sub: getComputedStyle(band.querySelector('.metric small')!).color,
        interactive: band.querySelectorAll('button, a, [role="button"], [aria-expanded]').length,
        scrollX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(m.labels).toEqual([
      'Выручка с начала года',
      'НДС начислен',
      'Прогноз НДС за год',
      'Налог на прибыль: прогноз за год',
    ]);
    expect(m.values.every((v) => v && v.length > 0)).toBe(true);
    expect(new Set(m.tops).size).toBe(1); // один ряд
    expect(new Set(m.valueTops).size).toBe(1); // числа на одной линии
    expect(new Set(m.lefts).size).toBe(4); // четыре столбца
    expect(m.inside).toBe(true);
    expect(m.clipped).toBe(false);
    expect(m.bg).toBe(WINE);
    expect(m.color).toBe('rgb(255, 248, 224)'); // #FFF8E0
    expect(m.sub).toBe('rgb(232, 207, 203)'); // #E8CFCB
    expect(m.radius).toBe('22px');
    expect(m.interactive).toBe(0); // как в первой версии: баннер не раскрывается
    expect(m.scrollX).toBeLessThanOrEqual(0);

    // живая выручка тикает
    const before = await page.locator('.band .metric strong').first().textContent();
    await expect.poll(async () => page.locator('.band .metric strong').first().textContent(), { timeout: 5000 }).not.toBe(before);

    // 1024 px: ещё баннер группы; 1023 px: уже четыре отдельных
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.locator('.band .metric')).toHaveCount(4);
    await expect(page.locator('.sum-card')).toHaveCount(0);
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect(page.locator('.sum-card')).toHaveCount(4);
    await expect(page.locator('.band')).toHaveCount(0);
  });
});
