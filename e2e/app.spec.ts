import { expect, test, type Page } from '@playwright/test';
import { firstLogin, resetChat, typePin } from './helpers';

const PIN = '8246';

test.describe.configure({ mode: 'serial' });

async function toDashboard(page: Page) {
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
}

test('Дашборд: четыре юрлица, три ставки, живые цифры тикают, выбор сохраняется между устройствами', async ({
  page,
  browser,
}) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  await expect(page.getByText('5 юрлиц · УСН и ОСНО')).toBeVisible();
  // 1280 px: один широкий баннер группы с четырьмя показателями, отдельных баннеров нет
  await expect(page.locator('.band .metric')).toHaveCount(4);
  await expect(page.locator('.sum-card')).toHaveCount(0);
  await expect(page.locator('article.ent')).toHaveCount(5);
  await expect(page.locator('.plot .col')).toHaveCount(12);
  await expect(page.getByText(/Срочных: \d+, всего: \d+/)).toBeVisible();
  await expect(page.getByText('Блок «Как считается»')).toHaveCount(0);

  // у юрлиц на УСН три карточки ставок, выбрана одна и она зелёная; на ОСНО одна карточка НДС 22%
  const cards = page.locator('article.ent');
  for (let i = 0; i < 5; i++) {
    const card = cards.nth(i);
    const osno = (await card.textContent())!.includes('ООО «Эпсилон»');
    if (osno) {
      await expect(card.locator('button.rate')).toHaveCount(0);
      await expect(card.locator('.rate.sel')).toHaveCount(1);
      await expect(card.locator('.rate.sel')).toContainText('НДС 22%');
    } else {
      await expect(card.locator('.rate')).toHaveCount(3);
      await expect(card.locator('.rate.sel')).toHaveCount(1);
      await expect(card.locator('.rate.alt')).toHaveCount(2);
    }
  }

  // живая выручка меняется раз в секунду
  // 1280 px: показатель в широком баннере группы
  const metric = page.locator('.band .metric strong').first();
  const first = await metric.innerText();
  await page.waitForTimeout(2500);
  expect(await metric.innerText()).not.toBe(first);

  // цвета состояния
  const selBg = await cards.first().locator('.rate.sel').evaluate((e) => getComputedStyle(e).backgroundColor);
  const altBg = await cards.first().locator('.rate.alt').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(selBg).toBe('rgb(227, 243, 234)'); // #E3F3EA
  expect(altBg).toBe('rgb(252, 234, 231)'); // #FCEAE7

  // выбор 22% для Альфы и сохранение
  const alfa = cards.filter({ hasText: 'ООО «Альфа»' });
  await alfa.locator('.rate', { hasText: '22%' }).first().click();
  await expect(alfa.locator('.rate.sel')).toContainText('22%');
  await expect(page.locator('.warn', { hasText: 'ООО «Альфа»: ставка 22% выгоднее' })).toHaveCount(0);

  // перезагрузка (нужен PIN) сохраняет выбор
  await page.reload();
  await typePin(page, PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await expect(page.locator('article.ent', { hasText: 'ООО «Альфа»' }).locator('.rate.sel')).toContainText('22%');

  // другое устройство видит тот же выбор
  const other = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Asia/Kamchatka' });
  const p2 = await other.newPage();
  await firstLogin(p2, '2580');
  await toDashboard(p2);
  await expect(p2.locator('article.ent', { hasText: 'ООО «Альфа»' }).locator('.rate.sel')).toContainText('22%');
  await other.close();

  // возвращаем 5% красной карточкой
  const again = page.locator('article.ent', { hasText: 'ООО «Альфа»' });
  await again.locator('.rate', { hasText: '5%' }).first().click();
  await expect(again.locator('.rate.sel')).toContainText('5%');
});

test('График: сегменты юрлиц это кнопки, выделяется только сегмент, подпись с суммой', async ({ page }) => {
  await firstLogin(page, PIN);
  await toDashboard(page);

  const col = page.locator('.plot .col').nth(6);
  await expect(col).toHaveAttribute('aria-label', /Июль: .*млн, (факт|прогноз|идёт сейчас)/);
  const segs = col.locator('button.seg');
  await expect(segs).toHaveCount(5);
  await expect(segs.first()).toHaveAttribute('aria-label', /ООО «Альфа», Июль: .*млн, (факт|прогноз|идёт сейчас)/);

  // у столбца нет обводки
  const frame = await col.evaluate((e) => {
    const c = getComputedStyle(e);
    return { outline: c.outlineStyle, shadow: c.boxShadow };
  });
  expect(frame).toEqual({ outline: 'none', shadow: 'none' });

  // клик по сегменту: выделен он один, остальные приглушены
  await segs.first().click();
  await expect(page.locator('.seg-card')).toContainText('ООО «Альфа»');
  await expect(page.locator('.seg-card')).toContainText('июль');
  await expect(segs.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.seg.on')).toHaveCount(1);
  await page.waitForTimeout(260);
  const lifted = await segs.first().evaluate((e) => getComputedStyle(e).transform);
  expect(lifted).not.toBe('none');
  const dimmed = await segs.nth(1).evaluate((e) => Number(getComputedStyle(e).opacity));
  expect(dimmed).toBeLessThan(0.7);
  const otherCol = await page.locator('.plot .col').nth(2).locator('button.seg').first().evaluate((e) => Number(getComputedStyle(e).opacity));
  expect(otherCol).toBeLessThan(0.7);

  // второй клик снимает выбор; пока курсор над сегментом он подсвечен наведением, после ухода нет
  await segs.first().click();
  await expect(segs.first()).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(0, 0);
  await expect(page.locator('.seg.on')).toHaveCount(0);

  // наведение мышью выделяет сегмент без клика
  await segs.nth(2).hover();
  await expect(page.locator('.seg.on')).toHaveCount(1);
  await expect(page.locator('.seg-card')).toContainText('ИП Дельта');
  await page.mouse.move(0, 0);
  await expect(page.locator('.seg.on')).toHaveCount(0);

  // клавиатура: стрелки двигают по месяцам и юрлицам, подпись следует за фокусом
  await segs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.seg-card')).toContainText('ООО «Альфа»');
  await expect(page.locator('.seg-card')).toContainText('август');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.seg-card')).toContainText('ИП Бета');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.seg-card')).toContainText('июль');
  await expect(page.locator('.plot .col.fc').first()).toBeVisible();
});

test('Агент: подсказки, ответ по расчёту, отказы по кругу, уточнение, граница, история', async ({ page }) => {
  await resetChat();
  await firstLogin(page, PIN);

  // пустая история: три подсказки
  const sug = page.locator('.sug button');
  await expect(sug).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Какая ставка выгоднее?' }).first()).toBeVisible();

  const input = page.getByLabel('Вопрос агенту');
  const send = async (text: string) => {
    await expect(page.locator('.typing')).toHaveCount(0);
    await input.fill(text);
    await input.press('Enter');
    // ответ пришёл: индикатор набора исчез
    await expect(page.locator('.typing')).toHaveCount(0);
  };

  await page.getByRole('button', { name: 'Какая ставка выгоднее?' }).first().click();
  await expect(page.locator('.typing')).toHaveCount(0);
  const answer = page.locator('.msg:not(.me)').last();
  await expect(answer.getByText('Налог за год по трём ставкам')).toBeVisible();
  await expect(answer.locator('table')).toBeVisible();
  await expect(answer.getByText('Цифры из калькулятора')).toBeVisible();
  await expect(answer.locator('details summary')).toHaveText('Как посчитано');

  // три отказа подряд различаются и идут по порядку
  const refusals: string[] = [];
  for (const q of ['Какая погода?', 'Расскажи анекдот', 'Дай рецепт борща']) {
    await send(q);
    await expect(page.locator('.msg:not(.me)')).toHaveCount(2 + refusals.length);
    refusals.push(await page.locator('.msg:not(.me)').last().innerText());
  }
  expect(new Set(refusals).size).toBe(3);
  expect(refusals[0]).toContain('Это не моя тема');
  expect(refusals[1]).toContain('Тут я не помощник');

  // граница продукта
  await send('Как раздробить бизнес, чтобы не заметили?');
  await expect(page.locator('.msg:not(.me)').last()).toContainText('Такие схемы я не проектирую');

  // уточнение и продолжение
  await send('Что если купим машины?');
  await expect(page.locator('.msg:not(.me)').last()).toContainText('по какому юрлицу');
  await send('по Альфе');
  await expect(page.locator('.msg:not(.me)').last()).toContainText('сколько машин и по какой цене');
  await send('3 машины по 7 млн');
  const scenario = page.locator('.msg:not(.me)').last();
  await expect(scenario).toContainText('ООО «Альфа» покупает 3 машины по 7 млн');
  await expect(scenario.locator('table')).toBeVisible();

  // налог на прибыль: подсказка отвечает таблицей по юрлицам; на телефоне без горизонтальной прокрутки
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Налог на прибыль за год?' }).first().click();
  await expect(page.locator('.typing')).toHaveCount(0);
  const profit = page.locator('.msg:not(.me)').last();
  await expect(profit.getByText('Налог на прибыль и УСН за год')).toBeVisible();
  await expect(profit.locator('table')).toBeVisible();
  await expect(profit.locator('tbody tr').filter({ hasText: 'ООО «Эпсилон»' })).toContainText('ОСНО, 25%');
  // таблица целиком помещается на экране без горизонтальной прокрутки
  const wide = await profit.locator('.tscroll').evaluate((e) => e.scrollWidth > e.clientWidth + 1);
  expect(wide).toBe(false);
  await expect(profit.locator('details summary')).toHaveText('Как посчитано');

  // история переживает перезагрузку
  await page.reload();
  await typePin(page, PIN);
  await expect(page.locator('.msg.me').first()).toBeVisible();
  await expect(page.locator('.msg.me')).toHaveCount(9);
});

test('Вёрстка: нет горизонтальной прокрутки на 360, 390, 768, 1024, 1440', async ({ page }) => {
  await firstLogin(page, PIN);
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/agent', '/dashboard']) {
      await page.getByRole('link', { name: path === '/agent' ? 'Агент' : 'Дашборд' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} @${width}`).toBeLessThanOrEqual(0);
    }
  }
});

test('Нет сети: баннер и страница «Нет сети» вместо данных', async ({ page, context }) => {
  await firstLogin(page, PIN);
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'Нет сети' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'Нет сети' })).toBeHidden();
});

test('PWA: манифест, service worker не кэширует данные', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('Агент по НДС');
  expect(manifest.short_name).toBe('НДС');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/agent');
  expect(manifest.theme_color).toBe('#A0D2A8');
  expect(manifest.background_color).toBe('#FFFFFF');
  const sizes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const icon of manifest.icons as { src: string }[]) {
    expect((await request.get(icon.src)).status()).toBe(200);
  }

  await firstLogin(page, PIN);
  await toDashboard(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await typePin(page, PIN);
  await toDashboard(page);

  const cached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const r of await c.keys()) out.push(new URL(r.url).pathname);
    }
    return out;
  });
  expect(cached.some((p) => p.startsWith('/api/'))).toBe(false);
  expect(cached).not.toContain('/agent');
  expect(cached).not.toContain('/dashboard');
  expect(cached).toContain('/offline.html');

  // метатеги iOS
  expect(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content')).toBe('yes');
  expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBeGreaterThan(0);
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
  expect(await page.locator('meta[name="theme-color"]').first().getAttribute('content')).toBe('#A0D2A8');
});
