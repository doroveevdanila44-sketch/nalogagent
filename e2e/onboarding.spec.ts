import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_DB_URL } from '../playwright.config';
import {
  CHAPTER_TITLE,
  FULL_TOUR_STEPS,
  LINE_LABELS,
  TOUR_STEPS,
  type TourStep,
} from '../components/onboarding/chapters';
import { firstLogin, resetChat, typePin } from './helpers';

const PIN = '8246';
const SHOTS = '.data/shots';
/** Первый показ: восемь шагов. Все подсказки (25 шагов) открываются кнопкой меню «Показать подсказки заново». */
const TOTAL = TOUR_STEPS.length;
const FULL_TOTAL = FULL_TOUR_STEPS.length;
type Mode = 'short' | 'full';
const stepsOf = (mode: Mode) => (mode === 'full' ? FULL_TOUR_STEPS : TOUR_STEPS);
const totalOf = (mode: Mode) => stepsOf(mode).length;

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

/** Отметка «обучение пройдено» в базе: null сбрасывает, строка времени ставит. */
async function setSeen(value: Date | null): Promise<void> {
  await sql(
    `insert into user_prefs (user_id, onboarding_seen_at) select id, $1 from users
     on conflict (user_id) do update set onboarding_seen_at = excluded.onboarding_seen_at`,
    [value],
  );
}

async function seenAt(): Promise<string | null> {
  const rows = await sql<{ at: Date | null }>('select onboarding_seen_at as at from user_prefs limit 1');
  return rows[0]?.at ? rows[0].at.toISOString() : null;
}

// после этого файла тур не должен перекрывать остальные тесты, а пример документа и вопрос агента не остаются
test.afterAll(async () => {
  await setSeen(new Date());
  await sql('delete from documents');
  await resetChat();
});

const tour = (page: Page) => page.getByTestId('tour');
const card = (page: Page) => page.getByTestId('tour-card');
const next = (page: Page) => card(page).getByRole('button', { name: /^(Дальше|Готово)$/ });
const count = (page: Page) => page.getByTestId('tour-count');
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

/**
 * Вырез стоит на одном из элементов шага (с зазором 6 px вокруг): ждём, пока он доедет. Берутся
 * только видимые элементы вне закрытых панелей, как в самом туре.
 */
async function expectHoleOnStep(page: Page, selectors: string[], timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const hole = await page.getByTestId('tour-hole').boundingBox();
        if (!hole) return 'нет выреза';
        for (const sel of selectors) {
          const boxes = await page.locator(sel).evaluateAll((els) =>
            els.map((e) => {
              const r = e.getBoundingClientRect();
              const ok = r.width > 0 && r.height > 0 && !e.closest('[inert]:not([data-tour-inert])') && !e.closest('[hidden]');
              return { x: r.x, y: r.y, w: r.width, h: r.height, ok };
            }),
          );
          for (const b of boxes) {
            if (!b.ok) continue;
            // зазор 6 px вокруг, но не за краем окна
            const vw = page.viewportSize()!.width;
            const vh = page.viewportSize()!.height;
            const l = Math.max(0, b.x - 6);
            const tp = Math.max(0, b.y - 6);
            const r = Math.min(vw, b.x + b.w + 6);
            const bt = Math.min(vh, b.y + b.h + 6);
            const d = [hole.x - l, hole.y - tp, hole.width - (r - l), hole.height - (bt - tp)];
            if (d.every((v) => Math.abs(v) <= 2)) return 'совпал';
          }
        }
        return 'не совпал';
      },
      { timeout },
    )
    .toBe('совпал');
}

/** Три строки шага: метки «Что это», «Как читать», «Что делать» жирные, текст не пустой и короткий. */
async function expectThreeLines(page: Page, label: string): Promise<string[]> {
  await cardReady(page, label);
  const rows = card(page).locator('.tour-body p');
  await expect(rows, label).toHaveCount(3);
  const labels = await card(page).locator('.tour-body p > b').allInnerTexts();
  expect(labels, label).toEqual(LINE_LABELS.map((l) => `${l.label}:`));
  const texts = await rows.allInnerTexts();
  for (const t of texts) {
    expect(t.length, `${label}: ${t}`).toBeGreaterThan(18);
    expect(t.length, `${label}: ${t}`).toBeLessThanOrEqual(200);
    expect(/[\u2012-\u2015]/.test(t), `${label}: длинное тире`).toBe(false);
  }
  return texts;
}

const stepByIndex = (i: number, mode: Mode = 'short'): TourStep => stepsOf(mode)[i]!;

/**
 * В окружении тестов сессия блокируется после 15 секунд без обращений к серверу (PIN_IDLE_MINUTES
 * 0.25). Долгий проход тура упирается в это: появляется экран PIN, человек вводит PIN, тур
 * возвращается на тот же шаг. Тест делает то же самое и ждёт, пока карточка снова видна.
 */
async function cardReady(page: Page, label: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const lock = page.getByRole('dialog', { name: 'Ввод PIN' });
        if (await lock.isVisible().catch(() => false)) {
          await typePin(page, PIN);
          await expect(lock).toHaveCount(0);
        }
        return card(page).isVisible();
      },
      { message: `${label}: карточка видна`, timeout },
    )
    .toBe(true);
}

/** Закрывает тур кнопкой «Пропустить обучение»: единственный способ, кроме «Готово» на последнем шаге. */
const skip = (page: Page) => card(page).getByRole('button', { name: 'Пропустить обучение' }).click();

/**
 * Следит в самой странице: затемнение (вырез) без видимой карточки показываться не должно ни в
 * один кадр. Нарушения копятся в window.__tourViolations.
 */
async function watchInvariant(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tourViolations: string[]; __tourWatch?: boolean };
    w.__tourViolations = [];
    if (w.__tourWatch) return;
    w.__tourWatch = true;
    const tick = () => {
      const hole = document.querySelector('[data-testid="tour-hole"]');
      const card = document.querySelector<HTMLElement>('[data-testid="tour-card"]');
      if (hole && (!card || getComputedStyle(card).visibility === 'hidden')) {
        w.__tourViolations.push(`вырез без карточки, шаг ${document.querySelector('[data-testid="tour"]')?.getAttribute('data-step')}`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __tourViolations?: string[] }).__tourViolations ?? []);

/** Карточка на экране целиком, вырез (если есть) целиком в окне просмотра. */
async function expectInWindow(page: Page, label: string): Promise<void> {
  const g = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
    const hole = document.querySelector('[data-testid="tour-hole"]')?.getBoundingClientRect() ?? null;
    return {
      card: { l: c.left, r: c.right, t: c.top, b: c.bottom },
      hole: hole ? { l: hole.left, r: hole.right, t: hole.top, b: hole.bottom } : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
  expect(g.card.l, label).toBeGreaterThanOrEqual(0);
  expect(g.card.r, label).toBeLessThanOrEqual(g.vw + 0.5);
  expect(g.card.t, label).toBeGreaterThanOrEqual(0);
  expect(g.card.b, label).toBeLessThanOrEqual(g.vh + 0.5);
  if (g.hole) {
    expect(g.hole.l, `${label}: вырез в окне`).toBeGreaterThanOrEqual(-1);
    expect(g.hole.t, `${label}: вырез в окне`).toBeGreaterThanOrEqual(-1);
    expect(g.hole.r, `${label}: вырез в окне`).toBeLessThanOrEqual(g.vw + 1);
    expect(g.hole.b, `${label}: вырез в окне`).toBeLessThanOrEqual(g.vh + 1);
  }
}

/**
 * Быстрый обход всех шагов для проверки гонок: на каждом шаге карточка видна и в окне, счётчик
 * верный, подсвечен существующий элемент или карточка стоит по центру, нажатие на затемнение
 * ничего не закрывает.
 */
async function walkAll(page: Page, label: string, mode: Mode = 'full'): Promise<void> {
  const total = totalOf(mode);
  for (let i = 0; i < total; i += 1) {
    const step = stepByIndex(i, mode);
    const at = `${label}, шаг ${i + 1} (${step.id})`;
    await cardReady(page, at);
    await expect(count(page), at).toHaveText(`Шаг ${i + 1} из ${total}`);
    // подсвечен элемент шага (запасного вида «карточка по центру» на этом пути быть не должно)
    try {
      await expectHoleOnStep(page, step.targets, 20_000);
    } catch (e) {
      const phase = await tour(page).getAttribute('data-phase');
      throw new Error(`${at}: подсветка не встала, фаза ${phase}: ${(e as Error).message.split('\n')[0]}`);
    }
    await expectInWindow(page, at);
    // нажатие на затемнение вне выреза и карточки ничего не закрывает
    const spot = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
      const h = document.querySelector('[data-testid="tour-hole"]')?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inside = (x: number, y: number) =>
        (x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) ||
        (h && x >= h.left && x <= h.right && y >= h.top && y <= h.bottom);
      for (const [x, y] of [[4, vh / 2], [vw - 4, vh / 2], [vw / 2, vh - 4], [vw / 2, 70]] as const) {
        if (!inside(x, y)) return { x, y };
      }
      return null;
    });
    if (spot) {
      await page.mouse.click(spot.x, spot.y);
      await expect(tour(page), `${at}: затемнение не закрывает тур`).toBeVisible();
      await expect(count(page), at).toHaveText(`Шаг ${i + 1} из ${total}`);
    }
    if (i < total - 1) await next(page).click();
  }
}

/** Первый шаг тура, когда человек начал с вкладки «Агент»: подсвечено поле ввода */
const FIRST_TARGET = ['[data-tour="chat-input"]'];

/** Идёт по шагам кнопкой «Дальше» с нынешнего шага, пока счётчик не покажет нужный. */
async function goTo(page: Page, index: number, mode: Mode = 'short'): Promise<void> {
  const total = totalOf(mode);
  const current = async () => Number(/Шаг (\d+) из/.exec((await count(page).textContent()) ?? '')![1]) - 1;
  for (let i = await current(); i < index; i += 1) {
    await expect(count(page)).toHaveText(`Шаг ${i + 1} из ${total}`);
    await cardReady(page, `переход к шагу ${index + 1}, шаг ${i + 1}`);
    await next(page).click();
  }
  await expect(count(page)).toHaveText(`Шаг ${index + 1} из ${total}`);
}

const idx = (id: string, mode: Mode = 'short') => stepsOf(mode).findIndex((s) => s.id === id);

/** Открыть полный тур из меню: кнопка «Показать подсказки заново». */
async function openFullTour(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Показать подсказки заново' }).click();
  await expect(tour(page)).toBeVisible();
}

/** Число из строки «198,42 млн» в миллионах */
const mlnOf = (text: string): number => {
  const m = /(\d[\d ]*(?:,\d+)?)\s*млн/.exec(plain(text));
  if (!m) throw new Error(`нет числа в «${text}»`);
  return Number(m[1]!.replace(/ /g, '').replace(',', '.'));
};

for (const mode of ['short', 'full'] as const) {
  const total = totalOf(mode);
  const first = mode === 'short';
  for (const width of [390, 1440]) {
  test(
    first
      ? `Обучение: один раз после первого входа, ${total} шагов, три вопроса на шаг, подсветка, ${width} px`
      : `Обучение из меню: все подсказки (${total} шагов), три вопроса на шаг, подсветка, ${width} px`,
    async ({ page }) => {
    test.setTimeout(300_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    // первый показ: отметки нет, тур открывается сам; полный тур: отметка есть, тур открывается из меню
    await setSeen(first ? null : new Date('2026-10-01T09:00:00Z'));
    await resetChat();
    // на телефоне документов нет совсем: полный тур создаст пример; на компьютере он уже есть и берётся тот же
    if (width === 390) await sql('delete from documents');
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    if (!first) {
      await page.waitForTimeout(300);
      await expect(tour(page)).toHaveCount(0);
      await openFullTour(page);
    }

    // тур открылся, на первом шаге
    await expect(tour(page)).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('role', 'dialog');
    await expect(card(page)).toHaveAttribute('aria-modal', 'true');
    await expect(count(page)).toHaveText(`Шаг 1 из ${total}`);
    await expect(card(page).getByRole('button', { name: 'Назад' })).toBeDisabled();
    await expect(card(page).getByRole('button', { name: 'Пропустить обучение' })).toBeVisible();
    await watchInvariant(page);

    // страница под обучением недоступна
    for (const sel of ['header.top', '.app-body', 'nav.tabs']) {
      await expect(page.locator(sel)).toHaveAttribute('inert', '');
    }

    const titles: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const step = stepByIndex(i, mode);
      const label = `шаг ${i + 1} (${step.id})`;
      // карточка показывается, когда элемент найден и стоит на месте: до этого она скрыта
      await cardReady(page, label);
      await expect(count(page), label).toHaveText(`Шаг ${i + 1} из ${total}`);
      await expect(page.getByTestId('tour-chapter'), label).toHaveText(CHAPTER_TITLE[step.chapter]);
      if (typeof step.title === 'string') await expect(page.getByTestId('tour-title'), label).toHaveText(step.title);
      titles.push(await page.getByTestId('tour-title').innerText());
      const lines = await expectThreeLines(page, label);

      // подсвечен существующий элемент шага (метка data-tour есть в интерфейсе)
      try {
        await expectHoleOnStep(page, step.targets);
      } catch (e) {
        const phase = await tour(page).getAttribute('data-phase');
        throw new Error(`${label}: вырез не встал на элемент, фаза ${phase}: ${(e as Error).message.split('\n')[0]}`);
      }

      // карточка целиком в окне; у небольших элементов не накрывает подсвеченное
      const geo = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
        const h = document.querySelector('[data-testid="tour-hole"]')!.getBoundingClientRect();
        const overlap = !(c.right <= h.left || c.left >= h.right || c.bottom <= h.top || c.top >= h.bottom);
        return { l: c.left, r: c.right, t: c.top, b: c.bottom, vw: window.innerWidth, vh: window.innerHeight, overlap, hh: h.height };
      });
      expect(geo.l, label).toBeGreaterThanOrEqual(0);
      expect(geo.r, label).toBeLessThanOrEqual(geo.vw);
      expect(geo.t, label).toBeGreaterThanOrEqual(0);
      expect(geo.b, label).toBeLessThanOrEqual(geo.vh + 1);
      if (geo.hh < 160) expect(geo.overlap, `${label}: карточка закрывает подсвеченное`).toBe(false);

      // особенности шагов: пример, окно, страница, число из расчёта
      if (step.id === 'forecast') {
        if (width === 390) {
          // история была пустой: тур задал вопрос сам и сказал об этом
          expect(lines[2], label).toContain('мы задали этот вопрос за вас');
          await expect(page.locator('.msg.me').last()).toHaveText('Какую ставку выбрать на 2027 год');
        }
        await expect(page.locator('.msg:not(.me) .understood').last()).toContainText('2027 год');
        await expect(page.locator('.typing')).toHaveCount(0);
      }
      if (step.id === 'edit') await expect(page.locator('[data-tour="understood-edit"]').last()).toHaveText('Изменить');
      if (step.id === 'quick') {
        await expect(page.locator('[data-tour="quick"]').last().locator('.qreply').first()).toBeVisible();
      }
      if (step.id === 'answer-specialist') {
        await expect(page.locator('[data-tour="act-send"]').last()).toHaveText('Отправить на проверку');
      }
      if (step.id === 'banner-revenue') {
        const banner = await page.locator('[data-tour="banner-revenue"] .sum-value').innerText();
        const rubles = Number(plain(banner).replace(/[^\d]/g, ''));
        expect(Math.abs(mlnOf(lines[0]!) - rubles / 1_000_000), `${label}: ${lines[0]} и ${banner}`).toBeLessThanOrEqual(0.03);
      }
      if (step.id === 'banner-vat-forecast') {
        const banner = await page.locator('[data-tour="banner-vat-forecast"] .sum-value').innerText();
        expect(plain(lines[0]!), label).toContain(plain(banner));
        expect(await page.getByTestId('tour-title').innerText()).toMatch(/^НДС за \d{4} год, прогноз$/);
      }
      if (step.id === 'banner-profit') {
        const banner = await page.locator('[data-tour="banner-profit"] .sum-value').innerText();
        expect(plain(lines[0]!), label).toContain(plain(banner));
        const subs = plain(await page.locator('[data-tour="banner-profit"]').innerText());
        const usn = /УСН по остальным: (\d+,\d+ млн)/.exec(subs);
        expect(usn, `${label}: ${subs}`).not.toBeNull();
        expect(plain(lines[0]!), label).toContain(usn![1]!);
        expect(lines[2], label).toContain('28 апреля, июля и октября');
      }
      if (step.id === 'rates') {
        // суммы из карточки ставок первого плательщика: те же числа, что в строке шага
        const shown = plain(await page.locator('[data-tour="rates"]').first().innerText());
        for (const m of plain(lines[2]!).matchAll(/(\d+)% (\d+,\d+ млн)/g)) expect(shown, label).toContain(`${m[1]}%`);
      }
      if (step.id === 'tax-switch') {
        const drawer = page.getByTestId('overlay-drawer');
        await expect(drawer).toBeVisible();
        const tabs = drawer.locator('[data-tour="tax-switch"] [role="tab"]');
        await expect(tabs).toHaveCount(2);
        const names = await tabs.allInnerTexts();
        expect(names[0]).toMatch(/^Налог на прибыль/);
        expect(names[1]).toMatch(/^Налог по УСН/);
        await page.screenshot({ path: `${SHOTS}/tour-tax-switch-${width}.png` });
      } else if (mode === 'full' && i > idx('tax-switch', mode)) {
        await expect(page.getByTestId('overlay-drawer'), `${label}: окно расчёта закрыто`).toHaveCount(0);
      }
      if (step.id === 'doc-bar') {
        // первый шаг на странице документа: тур открыл её и взял один пример
        await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents\/[0-9a-f-]{36}$/);
        const docs = await sql<{ n: number }>('select count(*)::int as n from documents');
        expect(docs[0]!.n, 'пример документа один').toBe(1);
        await expect(page.locator('[data-tour="doc-gap"]').first()).toBeVisible();
      }
      if (step.chapter === 'menu') {
        await expect(page.getByRole('dialog', { name: 'Меню', exact: true }), label).toBeVisible();
      } else {
        await expect(page.getByRole('dialog', { name: 'Меню', exact: true }), label).toHaveCount(0);
      }
      if (i === 0 || step.id === 'banner-vat-forecast' || step.id === 'doc-bar' || step.id === 'menu-lock') {
        await page.screenshot({ path: `${SHOTS}/tour-${step.id}-${width}.png` });
      }

      if (i === total - 1) {
        await expect(next(page)).toHaveText('Готово');
      } else {
        await expect(next(page), label).toHaveText('Дальше');
        await next(page).click();
      }
    }
    expect(await violations(page), 'затемнения без карточки не было').toEqual([]);
    expect(titles.length).toBe(total);
    expect(new Set(titles).size, 'заголовки шагов разные').toBeGreaterThan(total - 3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // «Готово»: тур закрыт, человек там, откуда начал; меню и окна закрыты; отметка в базе
    if (first) expect(await seenAt()).toBeNull();
    await next(page).click();
    await expect(tour(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
    await expect(page.getByRole('dialog', { name: 'Меню', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('overlay-drawer')).toHaveCount(0);
    for (const sel of ['header.top', '.app-body', 'nav.tabs']) {
      await expect(page.locator(sel)).not.toHaveAttribute('inert', /.*/);
    }
    await expect.poll(seenAt).not.toBeNull();
    // время первого закрытия при пересмотре из меню не сдвигается
    if (!first) expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');

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
    },
  );
  }
}

test('Пример ответа: если «Понял так» уже есть в истории, тур вопрос не задаёт; пример документа берётся готовый', async ({ page }) => {
  test.setTimeout(120_000);
  await setSeen(new Date('2026-10-01T09:00:00Z'));
  await resetChat();
  await firstLogin(page, PIN);
  const input = page.getByLabel('Вопрос агенту');
  // ответ на этот вопрос уже несёт всё, что подсвечивает глава: «Понял так», уточнения, «Отправить на проверку»
  await input.fill('какую ставку выбрать на 2027 год');
  await input.press('Enter');
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(page.locator('.msg:not(.me) .understood').last()).toBeVisible();
  await expect(page.locator('[data-tour="quick"]').last()).toBeVisible();
  const before = (await sql<{ n: number }>('select count(*)::int as n from chat_messages'))[0]!.n;
  const docsBefore = (await sql<{ n: number }>('select count(*)::int as n from documents'))[0]!.n;

  await openFullTour(page);
  await goTo(page, idx('forecast', 'full'), 'full');
  const lines = await expectThreeLines(page, 'forecast');
  expect(lines[2]).not.toContain('за вас');
  await expectHoleOnStep(page, ['[data-tour="understood"]']);
  await goTo(page, idx('answer-specialist', 'full'), 'full');
  await expectHoleOnStep(page, ['[data-tour="act-send"]']);
  await page.waitForTimeout(600);
  expect((await sql<{ n: number }>('select count(*)::int as n from chat_messages'))[0]!.n).toBe(before);
  await skip(page);
  await expect(tour(page)).toHaveCount(0);
  expect((await sql<{ n: number }>('select count(*)::int as n from documents'))[0]!.n).toBe(docsBefore);
  expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');
});

for (const width of [390, 1440]) {
  test(`Меню: «Показать подсказки заново» рядом с «Заблокировать», «Сменить PIN», «Выйти», ${width} px`, async ({ page }) => {
    await setSeen(new Date('2026-10-01T09:00:00Z'));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await page.waitForTimeout(400);
    await expect(tour(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Меню' }).click();
    const menu = page.getByRole('dialog', { name: 'Меню', exact: true });
    const names = await menu.getByRole('button').allInnerTexts();
    expect(names).toEqual(
      expect.arrayContaining(['Заблокировать', 'Что проверено', 'Сменить PIN', 'Показать подсказки заново', 'Выйти']),
    );
    expect(names).not.toContain('Пересмотреть обучение');
    expect(names).not.toContain('Статусы проверок');
    const at = (n: string) => names.indexOf(n);
    expect(at('Показать подсказки заново')).toBeGreaterThan(at('Сменить PIN'));
    expect(at('Показать подсказки заново')).toBeLessThan(at('Выйти'));
    await page.screenshot({ path: `${SHOTS}/tour-menu-${width}.png` });

    await menu.getByRole('button', { name: 'Показать подсказки заново' }).click();
    await expect(menu).toHaveCount(0);
    await expect(tour(page)).toBeVisible();
    // все подсказки: полный тур, а не восемь шагов первого показа
    await expect(count(page)).toHaveText(`Шаг 1 из ${FULL_TOTAL}`);

    // Escape тур не закрывает; кнопка «Пропустить обучение» закрывает; время первого показа не сдвигается
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeVisible();
    await skip(page);
    await expect(tour(page)).toHaveCount(0);
    expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');

    // и снова из меню: листается, на последнем шаге «Готово», меню на шагах главы «Меню» открыто
    await openFullTour(page);
    await goTo(page, idx('menu-lock', 'full'), 'full');
    await expect(page.getByRole('dialog', { name: 'Меню', exact: true })).toBeVisible();
    await expectHoleOnStep(page, ['[data-tour="menu-lock"]']);
    await next(page).click();
    await expectHoleOnStep(page, ['[data-tour="menu-pin"]']);
    await expect(count(page)).toHaveText(`Шаг ${FULL_TOTAL} из ${FULL_TOTAL}`);
    await expect(card(page)).toContainText('Показать подсказки заново');
    await expect(next(page)).toHaveText('Готово');
    await next(page).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Меню', exact: true })).toHaveCount(0);
    expect(await seenAt()).toBe('2026-10-01T09:00:00.000Z');
  });
}

test('Закрывается только кнопкой: Escape, затемнение, пустое место, жест и «назад» браузера не закрывают', async ({ page }) => {
  await setSeen(null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(tour(page)).toBeVisible();
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  // нажатие на затемнение, на пустое место и двойное нажатие
  for (const [x, y] of [[700, 300], [1300, 800], [500, 150]] as const) {
    await page.mouse.click(x, y);
  }
  await page.mouse.dblclick(900, 450);
  await expect(tour(page)).toBeVisible();
  // кнопка «назад» браузера тур не закрывает: тур остаётся и возвращает на страницу шага
  await goTo(page, idx('banner-vat-forecast'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await page.goBack();
  await expect(tour(page)).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await expect(count(page)).toHaveText(`Шаг ${idx('banner-vat-forecast') + 1} из ${TOTAL}`);
  expect(await seenAt()).toBeNull();
  // единственный способ закрыть: «Пропустить обучение»
  await skip(page);
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(seenAt).not.toBeNull();
  // Escape не открыл и не закрыл ничего под обучением
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('«Показ»: нажатие по подсвеченному ничего не делает; «попробуйте»: проходит только нажатие по подсвеченному', async ({ page }) => {
  test.setTimeout(120_000);
  await setSeen(null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  // шаг «попробуйте»: баннер «НДС за год, прогноз»
  await goTo(page, idx('banner-vat-forecast'));
  await expect(tour(page)).toHaveAttribute('data-mode', 'try');
  await expectHoleOnStep(page, ['[data-tour="banner-vat-forecast"]']);
  const banner = page.locator('[data-tour="banner-vat-forecast"]');
  await expect(banner).toHaveAttribute('aria-expanded', 'false');
  // нажатие мимо выреза (на соседний баннер) ничего не раскрывает
  const other = (await page.locator('[data-tour="banner-vat"]').boundingBox())!;
  await page.mouse.click(other.x + other.width / 2, other.y + other.height / 2);
  await expect(page.locator('[data-tour="banner-vat"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(tour(page)).toBeVisible();
  // нажатие по подсвеченному доходит до страницы: расшифровка раскрылась
  const hole = (await page.getByTestId('tour-hole').boundingBox())!;
  await page.mouse.click(hole.x + hole.width / 2, hole.y + hole.height / 2);
  await expect(banner).toHaveAttribute('aria-expanded', 'true');
  await expect(tour(page)).toBeVisible();
  await expect(count(page)).toHaveText(`Шаг ${idx('banner-vat-forecast') + 1} из ${TOTAL}`);
  // следующий шаг: раскрытое сворачивается само
  await next(page).click();
  await expect(count(page)).toHaveText(`Шаг ${idx('warnings') + 1} из ${TOTAL}`);
  await expect(banner).toHaveAttribute('aria-expanded', 'false');

  // шаг «показ»: кнопка «Показать расчёт» подсвечена, но не нажимается
  await goTo(page, idx('actions'));
  await expect(tour(page)).toHaveAttribute('data-mode', 'show');
  await expectHoleOnStep(page, ['[data-tour="actions"]']);
  const h2 = (await page.getByTestId('tour-hole').boundingBox())!;
  await page.mouse.click(h2.x + 40, h2.y + h2.height / 2);
  await expect(page.getByTestId('overlay-drawer')).toHaveCount(0);
  await expect(tour(page)).toBeVisible();
  await skip(page);
});

for (const width of [390, 1440]) {
  test(`Гонки: тур проходится пять раз подряд без зависаний, карточка на каждом шаге, ${width} px`, async ({ page }) => {
    test.setTimeout(420_000);
    await setSeen(new Date('2026-10-01T09:00:00Z'));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await firstLogin(page, PIN);
    await page.waitForTimeout(300);
    for (let run = 1; run <= 5; run += 1) {
      const lock = page.getByRole('dialog', { name: 'Ввод PIN' });
      if (await lock.isVisible().catch(() => false)) await typePin(page, PIN);
      await openFullTour(page);
      await watchInvariant(page);
      await walkAll(page, `проход ${run}`, 'full');
      await expect(next(page)).toHaveText('Готово');
      await next(page).click();
      await expect(tour(page)).toHaveCount(0);
      expect(await violations(page), `проход ${run}: затемнения без карточки не было`).toEqual([]);
      await expect(page.getByTestId('overlay-drawer')).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Меню', exact: true })).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
    }
  });
}

test('«Пропустить» закрывает обучение с шага на другой странице; «Назад» возвращает на шаг', async ({ page }) => {
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await next(page).click();
  await expect(count(page)).toHaveText(`Шаг 3 из ${TOTAL}`);
  await card(page).getByRole('button', { name: 'Назад' }).click();
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  await expect(page.getByTestId('tour-title')).toHaveText('Подсказки');

  // со страницы дашборда: тур уводит туда и возвращает назад
  await goTo(page, idx('banner-vat-forecast'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
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
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  await page.keyboard.press('ArrowLeft');
  await expect(count(page)).toHaveText(`Шаг 1 из ${TOTAL}`);
  await expect(next(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText(`Шаг 3 из ${TOTAL}`);
});

test('prefers-reduced-motion: вырез и карточка без анимации', async ({ page }) => {
  await setSeen(null);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  // вырез появляется вместе с карточкой, когда элемент найден и стоит на месте
  await expect(page.getByTestId('tour-hole')).toBeVisible();
  const durations = await page.evaluate(() => {
    const ms = (v: string) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)));
    const hole = getComputedStyle(document.querySelector('[data-testid="tour-hole"]')!);
    const card = getComputedStyle(document.querySelector('[data-testid="tour-card"]')!);
    return { hole: ms(hole.transitionDuration), card: ms(card.transitionDuration), anim: ms(card.animationDuration) };
  });
  expect(durations.hole).toBeLessThan(1);
  expect(durations.card).toBeLessThan(1);
  expect(durations.anim).toBeLessThan(1);
  await skip(page);
  await expect(tour(page)).toHaveCount(0);

  // без reduce вырез переезжает плавно
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFullTour(page);
  await expect(page.getByTestId('tour-hole')).toBeVisible();
  const smooth = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="tour-hole"]')!).transitionDuration) * 1000);
  expect(smooth).toBeGreaterThanOrEqual(200);
  await skip(page);
});

test('Планшет 768 px: восемь шагов первого показа, карточка в окне и подсвеченное не закрыто', async ({ page }) => {
  test.setTimeout(120_000);
  await setSeen(null);
  await resetChat();
  await page.setViewportSize({ width: 768, height: 1024 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  for (let i = 0; i < 8; i += 1) {
    const step = stepByIndex(i);
    await expect(count(page)).toHaveText(`Шаг ${i + 1} из ${TOTAL}`);
    await expectHoleOnStep(page, i === 0 ? FIRST_TARGET : step.targets);
    const geo = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="tour-card"]')!.getBoundingClientRect();
      return { l: c.left, r: c.right, t: c.top, b: c.bottom, vw: window.innerWidth, vh: window.innerHeight };
    });
    expect(geo.l).toBeGreaterThanOrEqual(0);
    expect(geo.r).toBeLessThanOrEqual(geo.vw);
    expect(geo.t).toBeGreaterThanOrEqual(0);
    expect(geo.b).toBeLessThanOrEqual(geo.vh + 1);
    if (i < 7) await next(page).click();
  }
  await skip(page);
  await expect(tour(page)).toHaveCount(0);
});

test('Нажатие на затемнение и в вырез тур не закрывает', async ({ page }) => {
  await setSeen(null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  // вырез сначала едет к полю ввода: нажимаем, когда он встал на место
  await expectHoleOnStep(page, FIRST_TARGET);
  const hole = (await page.getByTestId('tour-hole').boundingBox())!;
  await page.mouse.click(hole.x + hole.width / 2, hole.y + hole.height / 2);
  await expect(tour(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/agent');
  await page.mouse.click(1000, 120);
  await expect(tour(page)).toBeVisible();
  await skip(page);
  await expect(tour(page)).toHaveCount(0);
});

test('Обучение прячется при блокировке на PIN и возвращается на том же шаге', async ({ page }) => {
  test.setTimeout(90_000);
  await setSeen(null);
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  await next(page).click();
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  // простой дольше порога (15 секунд в тестовом окружении): блокировка на PIN
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeVisible({ timeout: 40_000 });
  await expect(tour(page)).toBeHidden();
  await typePin(page, PIN);
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toHaveCount(0);
  await expect(tour(page)).toBeVisible();
  await expect(count(page)).toHaveText(`Шаг 2 из ${TOTAL}`);
  await skip(page);
});

test('Доступность: карточка обучения без нарушений axe на телефоне и компьютере', async ({ page }) => {
  test.setTimeout(120_000);
  await setSeen(null);
  await page.setViewportSize({ width: 390, height: 844 });
  await firstLogin(page, PIN);
  await expect(tour(page)).toBeVisible();
  const scan = async (label: string) => {
    // карточка появляется за 220 мс (полупрозрачная в начале): сканируем, когда она встала
    await page.waitForTimeout(450);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      res.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any.map((a) => a.message).join(';')}`).join(' | ')}`),
    ).toEqual([]);
  };
  await scan('шаг 1, телефон');
  // шаг на дашборде: страница и вырез на месте
  await goTo(page, idx('banner-vat-forecast'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await expect(page).toHaveTitle(/.+/);
  await expectHoleOnStep(page, stepByIndex(idx('banner-vat-forecast')).targets);
  await scan('баннер, телефон');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await scan('баннер, компьютер');
  // меню одним шагом: подсвечено всё меню
  await goTo(page, idx('menu'));
  await expectHoleOnStep(page, ['[data-tour="menu-sheet"]']);
  await scan('меню, компьютер');
  await skip(page);
  await expect(tour(page)).toHaveCount(0);
});

test.describe('Жест на телефоне', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('смахнуть карточку вниз тур не закрывает', async ({ page }) => {
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
    await expect(tour(page)).toBeVisible();
    await expect(count(page)).toHaveText(`Шаг 1 из ${TOTAL}`);
    expect(await seenAt()).toBeNull();
    await skip(page);
    await expect(tour(page)).toHaveCount(0);
    await expect.poll(seenAt).not.toBeNull();
  });
});
