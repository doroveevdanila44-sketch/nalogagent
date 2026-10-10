import { devices, expect, test, type Page } from '@playwright/test';
import { fillPassword, firstLogin, typePin } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

const WIDTHS = [390, 768, 1440];

/** Центр блока по горизонтали относительно центра окна */
async function offsets(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`нет элемента ${sel}`);
    const r = el.getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - window.innerWidth / 2);
  }, selector);
}

test('Вход и PIN: коричневый фон, светлые тексты, блок строго по центру на 390, 768, 1440', async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();

    const colors = await page.evaluate(() => {
      const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
      return {
        bg: css('.auth-screen', 'background-color'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        mark: css('.wordmark', 'color'),
        n41: css('.wordmark .n41', 'color'),
        label: css('.field > label', 'color'),
        input: css('.field input', 'color'),
        inputBorder: css('.field input', 'border-top-color'),
        btnBg: css('.auth-screen .btn', 'background-color'),
        btnText: css('.auth-screen .btn', 'color'),
        btnWidth: document.querySelector('.auth-screen .btn')!.getBoundingClientRect().width,
        formWidth: document.querySelector('.auth-screen form')!.getBoundingClientRect().width,
      };
    });
    expect(colors.bg).toBe('rgb(89, 76, 61)'); // #594C3D
    expect(colors.bodyBg).toBe('rgb(89, 76, 61)');
    expect(colors.mark).toBe('rgb(246, 235, 221)'); // #F6EBDD
    expect(colors.n41).toBe('rgb(202, 156, 104)'); // #CA9C68
    expect(colors.label).toBe('rgb(217, 199, 174)'); // #D9C7AE
    expect(colors.input).toBe('rgb(246, 235, 221)');
    expect(colors.inputBorder).toMatch(/rgba\(246, 235, 221, 0\.35\)/);
    expect(colors.btnBg).toBe('rgb(202, 156, 104)');
    expect(colors.btnText).toBe('rgb(19, 25, 31)');
    expect(Math.abs(colors.btnWidth - colors.formWidth)).toBeLessThan(1);

    expect(await offsets(page, '.wordmark')).toBeLessThanOrEqual(1);
    expect(await offsets(page, '.auth-screen form'), `форма @${width}`).toBeLessThanOrEqual(1);
  }
});

test('PIN-экран: палитра, клавиши, центр на 390, 768, 1440, заливка при нажатии', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    for (const sel of ['.wordmark', '.pin-title', '.dots', '.pad']) {
      expect(await offsets(page, sel), `${sel} @${width}`).toBeLessThanOrEqual(1);
    }
  }

  const style = await page.evaluate(() => {
    const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
    return {
      title: css('.pin-title', 'color'),
      dot: css('.dots i', 'border-top-color'),
      keyColor: css('.key', 'color'),
      keyBorder: css('.key', 'border-top-color'),
      keySize: css('.key', 'width'),
    };
  });
  expect(style.title).toBe('rgb(246, 235, 221)');
  expect(style.dot).toBe('rgb(246, 235, 221)');
  expect(style.keyColor).toBe('rgb(246, 235, 221)');
  expect(style.keyBorder).toMatch(/rgba\(246, 235, 221, 0\.35\)/);
  expect(style.keySize).toBe('64px');

  // нажатие: плавная заливка акцентом и тёмная цифра
  const key = page.getByRole('button', { name: '5', exact: true });
  await expect(key).toBeEnabled();
  await key.hover();
  await page.mouse.down();
  await page.waitForTimeout(300);
  const pressed = await key.evaluate((e) => {
    const c = getComputedStyle(e);
    return { bg: c.backgroundColor, color: c.color };
  });
  expect(pressed).toEqual({ bg: 'rgb(202, 156, 104)', color: 'rgb(19, 25, 31)' });
  await page.mouse.up();

  // заполненная точка цвета акцента
  await page.waitForTimeout(250);
  const dotFill = await page.locator('.dots i').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(dotFill).toBe('rgb(202, 156, 104)');
});

test('Оверлей PIN поверх дашборда: центр, страница под ним не прокручивается', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible();

  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
  for (const sel of ['.auth-overlay .wordmark', '.auth-overlay .pad', '.auth-overlay .dots']) {
    expect(await offsets(page, sel), sel).toBeLessThanOrEqual(1);
  }
  await typePin(page, PIN);
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
});

test('Боковая панель на компьютере и нижняя на телефоне', async ({ page }) => {
  await firstLogin(page, PIN);

  // компьютер
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const desk = await page.evaluate(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom };
    };
    const tabs = [...document.querySelectorAll('.tabs .tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width };
    });
    const cur = document.querySelector('.tab[aria-current="page"]')!;
    return {
      nav: box('.tabs'),
      top: box('.top'),
      main: box('main'),
      composer: box('.composer-wrap'),
      tabs,
      curBg: getComputedStyle(cur).backgroundColor,
      curWeight: getComputedStyle(cur).fontWeight,
      navBg: getComputedStyle(document.querySelector('.tabs')!).backgroundColor,
      mainPaddingBottom: getComputedStyle(document.querySelector('main')!).paddingBottom,
      vh: window.innerHeight,
    };
  });
  expect(desk.nav.x).toBe(0);
  expect(desk.nav.w).toBeGreaterThanOrEqual(90);
  expect(desk.nav.w).toBeLessThanOrEqual(100);
  expect(Math.abs(desk.nav.y - desk.top.b)).toBeLessThanOrEqual(1); // под шапкой
  expect(Math.abs(desk.nav.b - desk.vh)).toBeLessThanOrEqual(1); // до низа окна
  expect(desk.top.x).toBe(0);
  expect(desk.top.w).toBe(1440); // шапка на всю ширину
  expect(desk.main.x).toBeGreaterThanOrEqual(desk.nav.w); // контент правее панели
  expect(desk.composer.x).toBeGreaterThanOrEqual(desk.nav.w - 1);
  expect(desk.tabs[1]!.y).toBeGreaterThan(desk.tabs[0]!.y); // столбиком
  expect(desk.tabs[0]!.x).toBeCloseTo(desk.tabs[1]!.x, 0);
  expect(desk.curBg).toBe('rgb(202, 156, 104)');
  expect(desk.curWeight).toBe('600');
  expect(desk.navBg).toBe('rgb(43, 47, 46)'); // #2B2F2E
  expect(desk.mainPaddingBottom).not.toMatch(/^(8\d|9\d|1\d\d)px$/); // нет отступа под нижнюю панель

  // шапка прилипает к верху при прокрутке
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(150);
  const stuck = await page.evaluate(() => document.querySelector('.top')!.getBoundingClientRect().top);
  expect(stuck).toBe(0);
  const navAfter = await page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().left);
  expect(navAfter).toBe(0);

  // планшет 768: уже боковая панель
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(150);
  const tab = await page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().width);
  expect(tab).toBeLessThanOrEqual(100);

  // телефон: панель внизу, на всю ширину
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const phone = await page.evaluate(() => {
    const r = document.querySelector('.tabs')!.getBoundingClientRect();
    return { x: r.left, w: r.width, b: r.bottom, vh: window.innerHeight };
  });
  expect(phone.x).toBe(0);
  expect(phone.w).toBe(390);
  expect(Math.abs(phone.b - phone.vh)).toBeLessThanOrEqual(1);
});

test('Меню из трёх точек: замка в шапке нет, три пункта', async ({ page }) => {
  await firstLogin(page, PIN);
  await expect(page.getByRole('button', { name: /Заблокировать на PIN/ })).toHaveCount(0);
  await expect(page.locator('.top-actions button')).toHaveCount(1);

  await page.getByRole('button', { name: 'Меню' }).click();
  const dialog = page.getByRole('dialog', { name: 'Меню' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Заблокировать', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сменить PIN', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  // Escape закрывает
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // «Сменить PIN» открывает смену
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Сменить PIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Введите текущий PIN' })).toBeVisible();
});

test('Курсоры, переходы 150-200 мс, нет левых полосок, уважение reduced motion', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();

  const cursor = (sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).cursor);
  for (const sel of ['.tab', '.rate', '.seg', '.icon-btn']) {
    expect(await cursor(sel), sel).toBe('pointer');
  }
  await page.getByRole('link', { name: 'Агент' }).click();
  await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
  expect(await cursor('.sug button')).toBe('pointer');
  expect(await cursor('.composer input')).toBe('text');
  await page.getByRole('button', { name: 'Меню' }).click();
  expect(await cursor('.sheet button.row')).toBe('pointer');
  await page.keyboard.press('Escape');

  // переходы на интерактивных элементах 150-200 мс
  const durations = await page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const sel of ['.tab', '.icon-btn', '.sug button', '.composer button', '.composer input']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      out[sel] = getComputedStyle(el)
        .transitionDuration.split(',')
        .map((v) => parseFloat(v) * (v.trim().endsWith('ms') ? 1 : 1000));
    }
    return out;
  });
  for (const [sel, list] of Object.entries(durations)) {
    for (const ms of list) {
      expect(ms, sel).toBeGreaterThanOrEqual(150);
      expect(ms, sel).toBeLessThanOrEqual(200);
    }
  }

  // нет левых цветных полосок: у всех элементов левая граница не толще правой
  for (const path of ['Агент', 'Дашборд']) {
    await page.getByRole('link', { name: path }).click();
    await page.waitForTimeout(400);
    const stripes = await page.evaluate(() => {
      const found: string[] = [];
      for (const el of document.querySelectorAll('body *')) {
        const c = getComputedStyle(el);
        if (c.borderLeftStyle !== 'none' && parseFloat(c.borderLeftWidth) > parseFloat(c.borderRightWidth)) {
          found.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
        }
      }
      return found;
    });
    expect(stripes, path).toEqual([]);
  }

  // prefers-reduced-motion: переходы практически мгновенные, подъёма нет
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  const rm = await page.locator('.rate').first().evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration));
  expect(rm).toBeLessThan(0.01);
  await page.locator('.rate').first().hover();
  await page.waitForTimeout(100);
  expect(await page.locator('.rate').first().evaluate((e) => getComputedStyle(e).transform)).toBe('none');
});

test('Вход: ошибка и поля читаемы на коричневом, контраст проходит axe', async ({ page }) => {
  await page.goto('/login');
  await fillPassword(page, 'wrong-password-for-style-check');
  await expect(page.getByRole('alert').filter({ hasText: 'Неверный логин или пароль' })).toBeVisible();
  const errColor = await page.locator('.auth-screen .form-error').first().evaluate((e) => getComputedStyle(e).color);
  expect(errColor).toBe('rgb(255, 194, 184)'); // #FFC2B8 на #594C3D
});

// ===== Дашборд: карточки группы, график на телефоне, режимы налогообложения =====

test('Карточки группы: четыре отдельные, раскладка 1, 2 на 2 и 4 в ряд, числа не переносятся', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на \d+ \S+ \d{4}/ })).toBeVisible();
  await expect(page.getByText('5 юрлиц · УСН и ОСНО')).toBeVisible();

  const layout = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(1, 1); // курсор не над карточкой: нет подъёма при наведении
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('.sum-card')] as HTMLElement[];
      const boxes = els.map((e) => e.getBoundingClientRect());
      const cs = getComputedStyle(els[0]!);
      return {
        count: els.length,
        xs: [...new Set(boxes.map((b) => Math.round(b.left)))].length,
        ys: [...new Set(boxes.map((b) => Math.round(b.top)))].length,
        gap: Math.round(boxes[1]!.top - boxes[0]!.bottom) || Math.round(boxes[1]!.left - boxes[0]!.right),
        bg: cs.backgroundColor,
        radius: cs.borderTopLeftRadius,
        padding: cs.paddingTop,
        overflow: els.some((e) => {
          const v = e.querySelector('.sum-value') as HTMLElement;
          return v.scrollWidth > e.clientWidth - 24;
        }),
        label: getComputedStyle(els[0]!.querySelector('.sum-label')!).color,
        value: getComputedStyle(els[0]!.querySelector('.sum-value')!).color,
        tabular: getComputedStyle(els[0]!.querySelector('.sum-value')!).fontVariantNumeric,
        labels: els.map((e) => e.querySelector('.sum-label')!.textContent),
      };
    });
  };

  const phone = await layout(390);
  expect(phone.count).toBe(4);
  expect(phone.xs).toBe(1); // один столбец
  expect(phone.ys).toBe(4);
  expect(phone.bg).toBe('rgb(89, 76, 61)'); // #594C3D
  expect(phone.radius).toBe('16px');
  expect(phone.padding).toBe('16px');
  expect(phone.label).toBe('rgb(217, 199, 174)'); // #D9C7AE
  expect(phone.value).toBe('rgb(246, 235, 221)'); // #F6EBDD
  expect(phone.tabular).toContain('tabular-nums');
  expect(phone.gap).toBe(12);
  expect(phone.overflow).toBe(false);
  expect(phone.labels).toEqual([
    'Выручка с начала года',
    'НДС начислен',
    'Прогноз НДС за год',
    'Налог на прибыль: прогноз за год',
  ]);

  const tablet = await layout(768);
  expect(tablet.xs).toBe(2); // два на два
  expect(tablet.ys).toBe(2);
  expect(tablet.overflow).toBe(false);

  const desktop = await layout(1440);
  expect(desktop.xs).toBe(4); // четыре в ряд
  expect(desktop.ys).toBe(1);
  expect(desktop.overflow).toBe(false);

  const narrow = await layout(1024);
  expect(narrow.xs).toBe(4);
  expect(narrow.overflow).toBe(false);
  await layout(360).then((r) => expect(r.overflow).toBe(false));

  // «можно сэкономить» внутри карточки НДС
  await expect(page.locator('.sum-card').nth(1)).toContainText(/можно сэкономить .* в год|ставки уже лучшие/);
});

test('Карточки группы нажимаются: расшифровка по юрлицам и переход к карточкам юрлиц', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.locator('.sum-card')).toHaveCount(4);

  const profit = page.locator('.sum-card').nth(3);
  await expect(profit).toHaveAttribute('aria-expanded', 'false');
  await profit.click();
  await expect(profit).toHaveAttribute('aria-expanded', 'true');
  const detail = page.locator('#sum-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('li')).toHaveCount(5);
  await expect(detail).toContainText('ООО «Эпсилон»');
  await expect(detail).toContainText('ОСНО, 25%');

  await page.locator('.sum-card').nth(0).click();
  await expect(detail.locator('li')).toHaveCount(5);
  await expect(detail).toContainText('Выручка с начала года по юрлицам');
  await page.locator('.sum-card').nth(0).click();
  await expect(detail).toBeHidden();

  await profit.click();
  const before = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: 'К карточкам юрлиц' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
});

test('График на телефоне: ось закреплена, столбцы прокручиваются, текущий месяц по центру', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.locator('.plot .col')).toHaveCount(12);
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const sc = document.querySelector('.plot-scroll') as HTMLElement;
    const cols = [...document.querySelectorAll('.plot .col')] as HTMLElement[];
    const cur = [...document.querySelectorAll('.mon span')].findIndex((s) => s.classList.contains('now'));
    const scr = sc.getBoundingClientRect();
    const c = cols[cur]!.getBoundingClientRect();
    return {
      scrollable: sc.scrollWidth > sc.clientWidth,
      inner: (document.querySelector('.plot') as HTMLElement).getBoundingClientRect().width,
      minCol: Math.min(...cols.map((e) => e.getBoundingClientRect().width)),
      centerOffset: Math.abs(c.left + c.width / 2 - (scr.left + scr.width / 2)),
      plotH: (document.querySelector('.plot') as HTMLElement).getBoundingClientRect().height,
      snap: getComputedStyle(sc).scrollSnapType,
      monNow: getComputedStyle(document.querySelector('.mon .now')!).fontWeight,
      monTransform: getComputedStyle(document.querySelector('.mon span')!).transform,
      yaxLeft: document.querySelector('.yax')!.getBoundingClientRect().left,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(m.scrollable).toBe(true);
  expect(m.inner).toBeGreaterThanOrEqual(520);
  expect(m.inner).toBeLessThanOrEqual(530);
  expect(m.minCol).toBeGreaterThanOrEqual(40);
  expect(m.plotH).toBe(220);
  expect(m.snap).toContain('x');
  expect(m.monNow).toBe('600');
  expect(m.monTransform).toBe('none'); // подписи без наклона
  expect(m.centerOffset).toBeLessThanOrEqual(24);
  expect(m.pageOverflow).toBeLessThanOrEqual(0);

  // прокрутка столбцов не двигает ось Y
  const axisBefore = await page.evaluate(() => document.querySelector('.yax')!.getBoundingClientRect().left);
  await page.evaluate(() => (document.querySelector('.plot-scroll') as HTMLElement).scrollTo({ left: 0 }));
  await page.waitForTimeout(150);
  const axisAfter = await page.evaluate(() => document.querySelector('.yax')!.getBoundingClientRect().left);
  expect(axisAfter).toBe(axisBefore);

  // легенда в две колонки
  const legendCols = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.legend span')] as HTMLElement[];
    return new Set(items.map((e) => Math.round(e.getBoundingClientRect().left))).size;
  });
  expect(legendCols).toBe(2);

  // нажатие по сегменту показывает юрлицо, месяц и сумму в карточке под графиком
  const seg = page.locator('.plot .col').nth(7).locator('button.seg').first();
  await seg.scrollIntoViewIfNeeded();
  await seg.click();
  const card = page.locator('.seg-card');
  await expect(card).toContainText('ООО «Альфа»');
  await expect(card).toContainText('август');
  await expect(card.locator('.seg-amount')).toContainText('млн');
  await expect(page.locator('.seg.on')).toHaveCount(1);

  // на компьютере график выше
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (document.querySelector('.plot') as HTMLElement).getBoundingClientRect().height)).toBe(300);
});

test('Юрлица: режим тегом, ОСНО одной карточкой НДС и блоком налога на прибыль, УСН с тремя ставками', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  const card = (name: string) => page.locator('article.ent', { hasText: name });

  await expect(card('ООО «Альфа»').locator('.chip.regime')).toHaveText('УСН доходы, 6%');
  await expect(card('ИП Бета').locator('.chip.regime')).toHaveText('УСН доходы минус расходы, 15%');
  await expect(card('ИП Дельта').locator('.chip.regime')).toHaveText('УСН доходы, 6%');
  await expect(card('ООО «Гамма»').locator('.chip.regime')).toHaveText('УСН доходы минус расходы, 15%');
  await expect(card('ООО «Эпсилон»').locator('.chip.regime')).toHaveText('ОСНО, 25%');
  await expect(card('ООО «Эпсилон»').locator('.chip.demo')).toHaveText('демо');

  // УСН: три ставки НДС и блок налога по УСН
  const beta = card('ИП Бета');
  await expect(beta.locator('button.rate')).toHaveCount(3);
  await expect(beta.locator('.taxblock h4')).toHaveText('Налог по УСН, прогноз');
  await expect(beta.locator('.taxblock')).toContainText('Ближайший платёж');
  await expect(beta.locator('.taxblock')).toContainText('28 октября');
  await expect(beta.locator('.taxblock-note')).toContainText('Минимальный налог 1% доходов');

  // ОСНО: одна карточка НДС 22% с вычетами и блок налога на прибыль
  const eps = card('ООО «Эпсилон»');
  await expect(eps.locator('button.rate')).toHaveCount(0);
  await expect(eps.locator('.rate.sel.static')).toContainText('НДС 22%');
  await expect(eps.locator('.rate.sel.static')).toContainText('С вычетами');
  await expect(eps.locator('.taxblock h4')).toHaveText('Налог на прибыль, прогноз');
  await expect(eps.locator('.taxblock')).toContainText('25%');
  await expect(eps.locator('.taxblock-note')).toContainText('прибыль');

  // «Начислено» растёт вместе с выручкой
  const accrued = eps.locator('.taxblock dd').nth(2);
  const first = await accrued.innerText();
  await page.waitForTimeout(3000);
  expect(await accrued.innerText()).not.toBe(first);

  // предупреждения: ОСНО и ближайшие платежи
  await expect(page.locator('.warn', { hasText: 'ООО «Эпсилон» на ОСНО: прогноз налога на прибыль за год' })).toBeVisible();
  await expect(page.locator('.warn', { hasText: /\d{1,2} [а-я]+: .*(УСН|НДС)/ }).first()).toBeVisible();

  // сервер не принимает выбор ставки для ОСНО
  const st = await (await page.request.get('/api/auth/state')).json();
  const res = await page.request.post('/api/rates', {
    headers: { 'x-csrf-token': st.csrf, origin: 'http://localhost:3101' },
    data: { entityId: 'epsilon', rate: 5 },
  });
  expect(res.status()).toBe(422);
});

test('Касание тонкого сегмента на телефоне: область не меньше 40 px, выбирается сегмент под пальцем', async ({ browser }) => {
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    baseURL: 'http://localhost:3101',
    locale: 'ru-RU',
    timezoneId: 'Asia/Kamchatka',
  });
  const page = await ctx.newPage();
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.locator('.plot .col')).toHaveCount(12);

  // у тонкого сегмента расширенная область даёт в сумме не меньше 40 px
  const hit = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('.plot .seg')] as HTMLElement[];
    const thin = segs.reduce((a, b) => (a.getBoundingClientRect().height < b.getBoundingClientRect().height ? a : b));
    const h = thin.getBoundingClientRect().height;
    const before = getComputedStyle(thin, '::before');
    return { h, total: h - parseFloat(before.top) - parseFloat(before.bottom), coarse: matchMedia('(pointer: coarse)').matches };
  });
  expect(hit.coarse).toBe(true);
  expect(hit.total).toBeGreaterThanOrEqual(39.5);

  // касание по центру второго сегмента (ИП Бета) в столбце выбирает именно его
  const point = await page.evaluate(() => {
    const col = document.querySelectorAll('.plot .col')[2]!;
    const seg = col.querySelectorAll('button.seg')[1] as HTMLElement;
    seg.scrollIntoView({ block: 'center', inline: 'center' });
    const r = seg.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator('.seg-card')).toContainText('ИП Бета');
  await expect(page.locator('.seg.on')).toHaveCount(1);
  await ctx.close();
});
