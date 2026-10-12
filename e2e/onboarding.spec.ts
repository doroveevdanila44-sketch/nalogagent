import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import { firstLogin, typePin } from './helpers';

const PIN = '8246';
const SHOTS = '.data/shots';

test.describe.configure({ mode: 'serial' });

/** Отметка «обучение пройдено» в базе: null сбрасывает, строка времени ставит. */
async function setSeen(value: Date | null): Promise<void> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    await client.query(
      `insert into user_prefs (user_id, onboarding_seen_at) select id, $1 from users
       on conflict (user_id) do update set onboarding_seen_at = excluded.onboarding_seen_at`,
      [value],
    );
  } finally {
    await client.end();
  }
}

async function seenAt(): Promise<string | null> {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    const res = await client.query<{ at: Date | null }>('select onboarding_seen_at as at from user_prefs limit 1');
    return res.rows[0]?.at ? res.rows[0].at.toISOString() : null;
  } finally {
    await client.end();
  }
}

// после этого файла тур не должен перекрывать остальные тесты
test.afterAll(async () => {
  await setSeen(new Date());
});

const TITLES = ['Агент', 'Дашборд', 'Ставки', 'Документы', 'Откуда цифры', 'Меню'];

const tour = (page: Page) => page.getByTestId('tour');
const card = (page: Page) => page.getByTestId('tour-card');
const next = (page: Page) => card(page).getByRole('button', { name: /^(Дальше|Готово)$/ });
const count = (page: Page) => page.getByTestId('tour-count');

/** Вырез совпадает с элементом (с зазором 6 px вокруг): ждём, пока он доедет. */
async function expectHoleOn(page: Page, selector: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const hole = await page.getByTestId('tour-hole').boundingBox();
        const target = await page.locator(selector).first().boundingBox();
        if (!hole || !target) return 'нет рамки';
        const d = [hole.x - (target.x - 6), hole.y - (target.y - 6), hole.width - (target.width + 12), hole.height - (target.height + 12)];
        return d.every((v) => Math.abs(v) <= 2) ? 'совпал' : d.map((v) => Math.round(v)).join(',');
      },
      { timeout: 6000 },
    )
    .toBe('совпал');
}

const STEP_TARGET = [
  'nav.tabs a[href="/agent"]',
  '.sum-cards',
  '.rates:not(.single)',
  'nav.tabs a[href="/documents"]',
  '[data-testid="source-line"]',
  'header.top button[aria-label="Меню"]',
];

for (const width of [390, 1440]) {
  test(`Обучение: один раз после первого входа, шесть шагов с подсветкой, ${width} px`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await setSeen(null);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);

    // тур открылся сам, на первом шаге
    await expect(tour(page)).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('role', 'dialog');
    await expect(card(page)).toHaveAttribute('aria-modal', 'true');
    await expect(count(page)).toHaveText('1 из 6');
    await expect(card(page).getByRole('heading')).toHaveText('Агент');
    await expect(card(page).getByRole('button', { name: 'Назад' })).toBeDisabled();
    await expect(card(page).getByRole('button', { name: 'Пропустить' })).toBeVisible();
    // карточка: заголовок, одна-две короткие строки, без длинных тире
    const lines = await card(page).locator('.tour-body p').allInnerTexts();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);

    // страница под обучением недоступна
    for (const sel of ['header.top', '.app-body', 'nav.tabs']) {
      await expect(page.locator(sel)).toHaveAttribute('inert', '');
    }

    const seen: string[] = [];
    for (let i = 0; i < TITLES.length; i += 1) {
      await expect(count(page)).toHaveText(`${i + 1} из 6`);
      await expect(card(page).getByRole('heading')).toHaveText(TITLES[i]!);
      seen.push(await card(page).getByRole('heading').innerText());
      await expectHoleOn(page, STEP_TARGET[i]!);

      // карточка целиком в окне и не накрывает подсвеченный элемент
      const geo = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
        const h = document.querySelector('[data-testid="tour-hole"]')!.getBoundingClientRect();
        const overlap = !(c.right <= h.left || c.left >= h.right || c.bottom <= h.top || c.top >= h.bottom);
        return { l: c.left, r: c.right, t: c.top, b: c.bottom, vw: window.innerWidth, vh: window.innerHeight, overlap, hRight: h.right, hTop: h.top };
      });
      expect(geo.l).toBeGreaterThanOrEqual(0);
      expect(geo.r).toBeLessThanOrEqual(geo.vw);
      expect(geo.t).toBeGreaterThanOrEqual(0);
      expect(geo.b).toBeLessThanOrEqual(geo.vh);
      if (i !== 1) expect(geo.overlap, `шаг ${i + 1}: карточка закрывает подсвеченное`).toBe(false);
      if (width === 1440 && i === 0) {
        // на компьютере подсвечена боковая панель, карточка рядом справа
        expect(geo.hRight).toBeLessThan(140);
        expect(geo.l).toBeGreaterThanOrEqual(geo.hRight);
      }
      if (width === 390 && i === 0) {
        // на телефоне это нижняя панель вкладок, карточка над ней
        expect(geo.hTop).toBeGreaterThan(700);
        expect(geo.b).toBeLessThanOrEqual(geo.hTop);
      }
      if (i === 0) await page.screenshot({ path: `${SHOTS}/tour-1-${width}.png` });
      if (i === 2) await page.screenshot({ path: `${SHOTS}/tour-3-${width}.png` });
      if (i === 5) {
        await expect(next(page)).toHaveText('Готово');
        await page.screenshot({ path: `${SHOTS}/tour-6-${width}.png` });
      } else {
        await expect(next(page)).toHaveText('Дальше');
        await next(page).click();
      }
    }
    expect(seen).toEqual(TITLES);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // «Готово»: тур закрыт, человек там, откуда начал; отметка в базе
    expect(await seenAt()).toBeNull();
    await next(page).click();
    await expect(tour(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
    for (const sel of ['header.top', '.app-body', 'nav.tabs']) {
      await expect(page.locator(sel)).not.toHaveAttribute('inert', /.*/);
    }
    await expect.poll(seenAt).not.toBeNull();

    // второй запуск (полная загрузка и PIN): обучение уже не показывается
    const prefs = page.waitForResponse((r) => r.url().endsWith('/api/prefs') && r.request().method() === 'GET');
    await page.reload();
    await typePin(page, PIN);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
    const r = await prefs;
    expect(((await r.json()) as { onboardingSeenAt: string | null }).onboardingSeenAt).not.toBeNull();
    await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(tour(page)).toHaveCount(0);
  });
}

for (const width of [390, 1440]) {
  test(`Обучение из меню: «Пересмотреть обучение» рядом с «Заблокировать», «Сменить PIN», «Выйти», ${width} px`, async ({ page }) => {
    await setSeen(new Date('2026-10-01T09:00:00Z'));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await page.waitForTimeout(400);
    await expect(tour(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Меню' }).click();
    const menu = page.getByRole('dialog', { name: 'Меню' });
    const names = await menu.getByRole('button').allInnerTexts();
    expect(names).toEqual(expect.arrayContaining(['Заблокировать', 'Сменить PIN', 'Пересмотреть обучение', 'Выйти']));
    const at = (n: string) => names.indexOf(n);
    expect(at('Пересмотреть обучение')).toBeGreaterThan(at('Сменить PIN'));
    expect(at('Пересмотреть обучение')).toBeLessThan(at('Выйти'));
    await page.screenshot({ path: `${SHOTS}/tour-menu-${width}.png` });

    await menu.getByRole('button', { name: 'Пересмотреть обучение' }).click();
    await expect(menu).toHaveCount(0);
    await expect(tour(page)).toBeVisible();
    await expect(count(page)).toHaveText('1 из 6');

    // Escape закрывает; время первого показа не сдвигается
    await page.keyboard.press('Escape');
    await expect(tour(page)).toHaveCount(0);
    expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');

    // и снова из меню, дойти до конца
    await page.getByRole('button', { name: 'Меню' }).click();
    await page.getByRole('button', { name: 'Пересмотреть обучение' }).click();
    await expect(tour(page)).toBeVisible();
    for (let i = 0; i < 5; i += 1) await next(page).click();
    await expect(count(page)).toHaveText('6 из 6');
    await next(page).click();
    await expect(tour(page)).toHaveCount(0);
    expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');
  });
}

test('Escape закрывает обучение и отмечает его пройденным', async ({ page }) => {
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(count(page)).toHaveText('2 из 6');
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(seenAt).not.toBeNull();
  // Escape не открыл и не закрыл ничего под обучением
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('«Пропустить» закрывает обучение; «Назад» возвращает на шаг', async ({ page }) => {
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await next(page).click();
  await expect(count(page)).toHaveText('3 из 6');
  await card(page).getByRole('button', { name: 'Назад' }).click();
  await expect(count(page)).toHaveText('2 из 6');
  await expect(card(page).getByRole('heading')).toHaveText('Дашборд');
  await card(page).getByRole('button', { name: 'Пропустить' }).click();
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(seenAt).not.toBeNull();
  // человек вернулся на страницу, с которой начал
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
});

test('Клавиатура: фокус заперт в карточке, стрелки листают, Enter идёт дальше', async ({ page }) => {
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="tour-card"]'));

  // фокус сразу на основной кнопке
  await expect(next(page)).toBeFocused();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  // программный фокус на страницу возвращается в карточку
  await page.evaluate(() => (document.querySelector('nav.tabs a') as HTMLElement | null)?.focus());
  expect(await inside()).toBe(true);

  await next(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('2 из 6');
  await page.keyboard.press('ArrowLeft');
  await expect(count(page)).toHaveText('1 из 6');
  await expect(next(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText('2 из 6');
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText('3 из 6');
});

test('prefers-reduced-motion: вырез и карточка без анимации', async ({ page }) => {
  await setSeen(null);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  const durations = await page.evaluate(() => {
    const ms = (v: string) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)));
    const hole = getComputedStyle(document.querySelector('[data-testid="tour-hole"]')!);
    const card = getComputedStyle(document.querySelector('[data-testid="tour-card"]')!);
    return { hole: ms(hole.transitionDuration), card: ms(card.transitionDuration), anim: ms(card.animationDuration) };
  });
  expect(durations.hole).toBeLessThan(1);
  expect(durations.card).toBeLessThan(1);
  expect(durations.anim).toBeLessThan(1);
  await page.keyboard.press('Escape');

  // без reduce вырез переезжает плавно
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Пересмотреть обучение' }).click();
  await expect(tour(page)).toBeVisible();
  const smooth = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="tour-hole"]')!).transitionDuration) * 1000);
  expect(smooth).toBeGreaterThanOrEqual(200);
  await page.keyboard.press('Escape');
});

test('Планшет 768 px: тур на боковой панели, карточка в окне', async ({ page }) => {
  await setSeen(null);
  await page.setViewportSize({ width: 768, height: 1024 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await expectHoleOn(page, STEP_TARGET[0]!);
  const geo = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
    const h = document.querySelector('[data-testid="tour-hole"]')!.getBoundingClientRect();
    return { cl: c.left, cr: c.right, hr: h.right, vw: window.innerWidth };
  });
  expect(geo.hr).toBeLessThan(140);
  expect(geo.cl).toBeGreaterThanOrEqual(geo.hr);
  expect(geo.cr).toBeLessThanOrEqual(geo.vw);
  for (let i = 1; i < 6; i += 1) {
    await next(page).click();
    await expectHoleOn(page, STEP_TARGET[i]!);
  }
  await next(page).click();
  await expect(tour(page)).toHaveCount(0);
});

test('Нажатие на затемнение закрывает, нажатие в вырез ничего не делает', async ({ page }) => {
  await setSeen(null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  // вырез сначала едет к вкладке: нажимаем, когда он встал на место
  await expectHoleOn(page, STEP_TARGET[0]!);
  const hole = (await page.getByTestId('tour-hole').boundingBox())!;
  await page.mouse.click(hole.x + hole.width / 2, hole.y + hole.height / 2);
  await expect(tour(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/agent');
  await page.mouse.click(1000, 600);
  await expect(tour(page)).toHaveCount(0);
});

test('Обучение прячется при блокировке на PIN и возвращается на том же шаге', async ({ page }) => {
  test.setTimeout(90_000);
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(count(page)).toHaveText('2 из 6');
  // простой дольше порога (15 секунд в тестовом окружении): блокировка на PIN
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible({ timeout: 40_000 });
  await expect(tour(page)).toBeHidden();
  await typePin(page, PIN);
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toHaveCount(0);
  await expect(tour(page)).toBeVisible();
  await expect(count(page)).toHaveText('2 из 6');
  await page.keyboard.press('Escape');
});

test('Доступность: карточка обучения без нарушений axe на телефоне и компьютере', async ({ page }) => {
  await setSeen(null);
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  const scan = async (label: string) => {
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      res.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any.map((a) => a.message).join(';')}`).join(' | ')}`),
    ).toEqual([]);
  };
  await scan('шаг 1, телефон');
  await next(page).click();
  await expect(count(page)).toHaveText('2 из 6');
  // переход на дашборд завершён: страница и вырез на месте
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await expect(page).toHaveTitle(/.+/);
  await expectHoleOn(page, STEP_TARGET[1]!);
  await scan('шаг 2, телефон');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await scan('шаг 2, компьютер');
  await page.keyboard.press('Escape');
});

test.describe('Жест на телефоне', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('смахнуть карточку вниз закрывает обучение, короткий жест не закрывает', async ({ page }) => {
    await setSeen(null);
    await firstLogin(page, PIN);
    await expect(tour(page)).toBeVisible();
    // карточка сначала в центре, потом переезжает к подсвеченному элементу: ждём, пока встанет
    let last = '';
    await expect
      .poll(async () => {
        const b = await card(page).boundingBox();
        const now = b ? `${Math.round(b.x)},${Math.round(b.y)}` : '';
        const same = now !== '' && now === last;
        last = now;
        return same;
      })
      .toBe(true);
    const box = (await card(page).boundingBox())!;
    const x = box.x + 40;
    const y = box.y + 20;
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (dy: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let s = 1; s <= 6; s += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * s) / 6 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    await swipe(20);
    await expect(tour(page)).toBeVisible();
    await swipe(140);
    await expect(tour(page)).toHaveCount(0);
    await expect.poll(seenAt).not.toBeNull();
  });
});
