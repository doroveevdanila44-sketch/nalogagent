import { expect, test, type Page } from '@playwright/test';
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
