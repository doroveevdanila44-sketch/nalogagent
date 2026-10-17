import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { firstLogin, pickSuggestion, resetChat } from './helpers';

const PIN = '8246';

/**
 * Экранная клавиатура iPhone. Настоящую клавиатуру iOS в эмуляции получить нельзя, поэтому её
 * воспроизводит подмена visualViewport, как у Safari: innerHeight остаётся прежним (раскладочный
 * вьюпорт не меняется, 100vh и 100dvh тоже), уменьшается только visualViewport.height, а Safari ещё и
 * сдвигает видимую область вниз по странице (offsetTop). Проверка на самом устройстве за владельцем.
 *
 * Два размера: iPhone 14 (390 на 844) и iPhone SE (375 на 667). Проект `webkit-iphone` (PW_WEBKIT=1)
 * прогоняет этот файл на движке Safari там, где Playwright его поддерживает (macOS 14 и новее); на
 * macOS 13 он не запускается, и тот же файл идёт в Chrome с размером и касанием iPhone.
 */

const SIZES = [
  { name: 'iPhone 14, 390 на 844', width: 390, height: 844, kb: 336 },
  { name: 'iPhone SE, 375 на 667', width: 375, height: 667, kb: 291 },
] as const;

const SHOTS = process.env.FLEET_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** visualViewport как у Safari: высота и сдвиг задаёт тест, остальное настоящее. */
async function fakeSafariViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.visualViewport!;
    const w = window as unknown as { __vvH?: number; __vvTop?: number };
    const proxy = new Proxy(real, {
      get(t, p) {
        if (p === 'height') return w.__vvH ?? window.innerHeight;
        if (p === 'offsetTop') return w.__vvTop ?? 0;
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    Object.defineProperty(window, 'visualViewport', { get: () => proxy });
  });
}

/** Клавиатура высотой `kb` открылась, Safari сдвинул видимую область на `pan`. */
async function setKeyboard(page: Page, kb: number, pan = 0): Promise<void> {
  await page.evaluate(
    ([k, p]) => {
      const w = window as unknown as { __vvH: number; __vvTop: number };
      w.__vvH = window.innerHeight - k;
      w.__vvTop = p;
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    },
    [kb, pan] as const,
  );
}

const css = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** Элемент целиком в видимой области visualViewport: от сдвига до сдвига плюс высота. */
async function insideVisible(page: Page, selector: string): Promise<{ ok: boolean; top: number; bottom: number; from: number; to: number }> {
  return page.evaluate((sel) => {
    const w = window as unknown as { __vvH?: number; __vvTop?: number };
    const from = w.__vvTop ?? 0;
    const to = from + (w.__vvH ?? window.innerHeight);
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { ok: r.top >= from - 0.5 && r.bottom <= to + 0.5, top: r.top, bottom: r.bottom, from, to };
  }, selector);
}

async function waitAnswer(page: Page): Promise<void> {
  await expect(page.locator('.typing')).toHaveCount(0);
}

for (const size of SIZES) {
  test.describe(`клавиатура iPhone: ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: true, isMobile: true });

    test('поле ввода чата после фокуса целиком над клавиатурой, оболочка на видимой области, навигация скрыта', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await fakeSafariViewport(page);
      await resetChat();
      await firstLogin(page, PIN);
      await pickSuggestion(page, 'Какая ставка выгоднее?');
      await waitAnswer(page);

      // клавиатуры нет: --vvh на всё окно, --kb 0, нижняя навигация на месте, подсказки свёрнуты ручкой
      expect(await css(page, '--vvh')).toBe(`${size.height}px`);
      expect(await css(page, '--kb')).toBe('0px');
      await expect(page.locator('nav.tabs')).toBeVisible();
      const shell0 = await page.locator('.app-shell').boundingBox();
      expect(Math.round(shell0!.height)).toBe(size.height);

      const field = page.getByLabel('Вопрос агенту');
      await field.focus();
      await setKeyboard(page, size.kb);
      await expect(page.locator('html[data-kb="open"]')).toHaveCount(1);
      expect(await css(page, '--vvh')).toBe(`${size.height - size.kb}px`);
      expect(await css(page, '--kb')).toBe(`${size.kb}px`);
      expect(Number.parseInt(await css(page, '--kb'), 10)).toBeGreaterThan(80);
      // нижняя навигация скрыта, подсказки свёрнуты до ручки
      await expect(page.locator('nav.tabs')).toBeHidden();
      await expect(page.locator('.sug-handle')).toHaveAttribute('aria-expanded', 'false');

      // через 350 мс после фокуса всё на месте
      await page.waitForTimeout(450);
      const shell = await page.locator('.app-shell').boundingBox();
      expect(Math.round(shell!.height)).toBe(size.height - size.kb);
      expect(Math.round(shell!.y)).toBe(0);
      const inField = await insideVisible(page, '.composer textarea');
      expect(inField.ok, JSON.stringify(inField)).toBe(true);
      const inButton = await insideVisible(page, '.composer button');
      expect(inButton.ok, JSON.stringify(inButton)).toBe(true);
      // список прокручен к последнему сообщению
      const gap = await page.evaluate(() => {
        const l = document.querySelector('.chat-scroll')!;
        return l.scrollHeight - l.clientHeight - l.scrollTop;
      });
      expect(gap).toBeLessThan(4);
      await shot(page, `kb-${size.width}x${size.height}-open`);

      // Safari сдвинул видимую область вниз на 120 px: оболочка и поле ввода встают на неё
      await setKeyboard(page, size.kb, 120);
      await expect.poll(async () => css(page, '--vv-top')).toBe('120px');
      const panned = await page.locator('.app-shell').boundingBox();
      expect(Math.round(panned!.y)).toBe(120);
      expect(Math.round(panned!.height)).toBe(size.height - size.kb);
      const header = await page.locator('header').first().boundingBox();
      expect(Math.round(header!.y)).toBe(120);
      const inPan = await insideVisible(page, '.composer textarea');
      expect(inPan.ok, JSON.stringify(inPan)).toBe(true);
      await shot(page, `kb-${size.width}x${size.height}-panned`);

      // клавиатура закрылась: всё возвращается, окно на (0, 0)
      await page.evaluate(() => {
        const w = window as unknown as { __vvH: number; __vvTop: number };
        w.__vvH = window.innerHeight;
        w.__vvTop = 0;
        window.visualViewport!.dispatchEvent(new Event('resize'));
        (document.activeElement as HTMLElement).blur();
      });
      await expect(page.locator('html[data-kb="open"]')).toHaveCount(0);
      expect(await css(page, '--kb')).toBe('0px');
      expect(await css(page, '--vvh')).toBe(`${size.height}px`);
      await expect(page.locator('nav.tabs')).toBeVisible();
      expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
      const back = await page.locator('.app-shell').boundingBox();
      expect([Math.round(back!.y), Math.round(back!.height)]).toEqual([0, size.height]);
    });

    test('поля карточки «Что если» и «Рассчитать» над клавиатурой', async ({ page }) => {
      test.setTimeout(120_000);
      await fakeSafariViewport(page);
      await resetChat();
      await firstLogin(page, PIN);
      await pickSuggestion(page, 'Что если купим 5 машин?');
      await waitAnswer(page);
      const form = page.locator('[data-form="fleet"]').last();
      await expect(form).toBeVisible();

      // фокус в поле, которое сейчас вне видимой области, затем клавиатура
      const rent = form.getByLabel('Цена сдачи, ₽ в сутки');
      await rent.evaluate((e) => (e as HTMLInputElement).focus({ preventScroll: true }));
      await setKeyboard(page, size.kb, 60);
      await expect(page.locator('html[data-kb="open"]')).toHaveCount(1);
      await page.waitForTimeout(450);

      const bar = () =>
        page.evaluate(() => {
          const b = document.querySelector('[data-form] .ff-bar')!.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom };
        });
      const fieldVisible = async (label: string) => {
        const id = await form.getByLabel(label).getAttribute('id');
        const r = await insideVisible(page, `[id="${id}"]`);
        const b = await bar();
        // поле целиком в видимой области и не под прижатой кнопкой «Рассчитать»
        const above = (await form.getByLabel(label).evaluate((e) => e.getBoundingClientRect().bottom)) <= b.top + 0.5;
        expect(r.ok, `${label}: ${JSON.stringify(r)}`).toBe(true);
        expect(above, `${label} над кнопкой`).toBe(true);
      };
      await fieldVisible('Цена сдачи, ₽ в сутки');

      // «Рассчитать» прижата к низу видимой области, пока карточка на экране
      const go = form.getByRole('button', { name: 'Рассчитать', exact: true });
      const goBox = await go.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height };
      });
      const composerTop = await page.evaluate(() => document.querySelector('.composer-wrap')!.getBoundingClientRect().top);
      expect(goBox.bottom).toBeLessThanOrEqual(composerTop + 0.5);
      expect(goBox.h).toBeGreaterThanOrEqual(44);
      const goVisible = await insideVisible(page, '[data-form] .ff-go');
      expect(goVisible.ok, JSON.stringify(goVisible)).toBe(true);

      // каждое следующее поле, взявшее фокус при открытой клавиатуре, тоже видно; список уводим в начало
      const list = page.locator('.chat-scroll');
      for (const label of ['Сколько машин', 'Стоимость одной машины, ₽', 'Дней сдачи в месяц', 'Расходы на машину в месяц, ₽ (необязательно)']) {
        await list.evaluate((e) => (e.scrollTop = 0));
        await form.getByLabel(label).evaluate((e) => (e as HTMLInputElement).focus({ preventScroll: true }));
        await expect.poll(async () => {
          const id = await form.getByLabel(label).getAttribute('id');
          return (await insideVisible(page, `[id="${id}"]`)).ok;
        }, { message: label }).toBe(true);
        await fieldVisible(label);
      }
      await shot(page, `kb-form-${size.width}x${size.height}`);

      // шапка и страница на месте
      expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
    });
  });
}

test.describe('поля ввода: шрифт не меньше 16 px, клавиша ввода', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('на экранах агента, документов и в окне «Отправить на проверку»', async ({ page }) => {
    test.setTimeout(120_000);
    await resetChat();
    await firstLogin(page, PIN);

    const audit = () =>
      page.evaluate(() => {
        const out: { what: string; size: number }[] = [];
        const skip = new Set(['checkbox', 'radio', 'hidden', 'button', 'submit', 'range', 'file', 'color']);
        for (const el of document.querySelectorAll<HTMLElement>('input, textarea, select')) {
          if (el instanceof HTMLInputElement && skip.has(el.type)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          out.push({
            what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}[${el.getAttribute('aria-label') ?? el.getAttribute('name') ?? ''}]`,
            size: parseFloat(cs.fontSize),
          });
        }
        return out;
      });

    // агент: поле чата
    const base = await audit();
    expect(base.length).toBeGreaterThan(0);
    for (const f of base) expect(f.size, f.what).toBeGreaterThanOrEqual(16);
    await expect(page.getByLabel('Вопрос агенту')).toHaveAttribute('enterkeyhint', 'send');

    // карточка сценария: числовые поля numeric, next, у последнего done
    await pickSuggestion(page, 'Что если купим 5 машин?');
    await waitAnswer(page);
    const form = page.locator('[data-form="fleet"]').last();
    const nums = await form.locator('input').evaluateAll((els) =>
      els.map((e) => ({ id: e.id, mode: e.getAttribute('inputmode'), hint: e.getAttribute('enterkeyhint') })),
    );
    expect(nums).toHaveLength(5);
    for (const n of nums) expect(n.mode, n.id).toBe('numeric');
    expect(nums.slice(0, -1).map((n) => n.hint)).toEqual(['next', 'next', 'next', 'next']);
    expect(nums.at(-1)!.hint).toBe('done');
    for (const f of await audit()) expect(f.size, f.what).toBeGreaterThanOrEqual(16);

    // окно «Отправить на проверку» с полем комментария
    await pickSuggestion(page, 'Налог на прибыль за год?');
    await waitAnswer(page);
    await page.locator('.msg:not(.me)').last().getByRole('button', { name: 'Отправить на проверку', exact: true }).click();
    await expect(page.locator('.ov-backdrop textarea, .ov-backdrop input[type="text"]').first()).toBeVisible();
    for (const f of await audit()) expect(f.size, f.what).toBeGreaterThanOrEqual(16);

    // окно закрывается, переходим в «Документы» нажатием на вкладку (перезагрузка потребовала бы PIN)
    await page.keyboard.press('Escape');
    if ((await page.locator('.ov-backdrop').count()) > 0) {
      await page.locator('.ov-backdrop').getByRole('button', { name: /Закрыть|Отмена/ }).first().click({ timeout: 3000 });
    }
    await expect(page.locator('.ov-backdrop')).toHaveCount(0);
    await page.getByRole('link', { name: 'Документы' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/documents/);
    await page.waitForTimeout(500);
    for (const f of await audit()) expect(f.size, f.what).toBeGreaterThanOrEqual(16);
  });
});
