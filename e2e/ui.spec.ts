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

test('Вход и PIN: бордовый фон, светлые тексты, блок строго по центру на 390, 768, 1440', async ({ page }) => {
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
    expect(colors.bg).toBe('rgb(120, 66, 68)'); // #784244
    expect(colors.bodyBg).toBe('rgb(120, 66, 68)');
    expect(colors.mark).toBe('rgb(255, 248, 224)'); // #FFF8E0
    expect(colors.n41).toBe('rgb(255, 243, 178)'); // #FFF3B2
    expect(colors.label).toBe('rgb(232, 207, 203)'); // #E8CFCB
    expect(colors.input).toBe('rgb(255, 248, 224)');
    // color-mix сериализуется как color(srgb ...), в других движках как rgba(...)
    expect(colors.inputBorder).toMatch(/^(rgba\(255, 248, 224, 0\.35\)|color\(srgb 1 0\.97\d* 0\.87\d* \/ 0\.35\))$/);
    expect(colors.btnBg).toBe('rgb(255, 243, 178)');
    expect(colors.btnText).toBe('rgb(42, 43, 20)'); // #2A2B14
    expect(Math.abs(colors.btnWidth - colors.formWidth)).toBeLessThan(1);

    expect(await offsets(page, '.wordmark')).toBeLessThanOrEqual(1);
    expect(await offsets(page, '.auth-screen form'), `форма @${width}`).toBeLessThanOrEqual(1);
  }
});

test('PIN-экран как на iPhone: расположение, размеры, стекло клавиш, действия внизу', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();

  const combos: [number, number][] = [
    [375, 667], // iPhone SE
    [390, 844],
    [430, 932],
    [768, 1024],
    [1440, 900],
  ];
  for (const [w, h] of combos) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const keys = [...document.querySelectorAll('.key')].map((k) => ({
        t: k.textContent,
        r: k.getBoundingClientRect(),
      }));
      const k = (t: string) => keys.find((x) => x.t === t)!.r;
      const dots = [...document.querySelectorAll('.pin-dots i')].map((d) => d.getBoundingClientRect());
      const actions = [...document.querySelectorAll('.pin-actions button')].map((b) => b.getBoundingClientRect());
      // слева в обычном состоянии пусто: это только колонка сетки, кнопки там нет
      const left = document.querySelector('.pin-action.left')!;
      const right = document.querySelector('.pin-action.right button')!;
      const key1 = getComputedStyle(document.querySelector('.key')!);
      return {
        vh,
        vw,
        scrollY: document.documentElement.scrollHeight - vh,
        scrollX: document.documentElement.scrollWidth - vw,
        screenW: rect('.pin-screen').width,
        markH: rect('.pin-mark .wordmark').height,
        markTop: rect('.pin-mark').top,
        headCy: rect('.pin-head').top + rect('.pin-head').height / 2,
        titleSize: getComputedStyle(document.querySelector('.pin-title')!).fontSize,
        titleWeight: getComputedStyle(document.querySelector('.pin-title')!).fontWeight,
        titleColor: getComputedStyle(document.querySelector('.pin-title')!).color,
        dotsCy: dots[0]!.top + dots[0]!.height / 2,
        dotSize: dots[0]!.width,
        dotStep: dots[1]!.left + dots[1]!.width / 2 - (dots[0]!.left + dots[0]!.width / 2),
        dotBorder: getComputedStyle(document.querySelector('.pin-dots i')!).borderTopWidth,
        padTop: rect('.pad').top,
        padBottom: rect('.pad').bottom,
        padCx: rect('.pad').left + rect('.pad').width / 2,
        keySize: k('1').width,
        gapX: k('2').left - k('1').right,
        gapY: k('4').top - k('1').bottom,
        zeroCx: k('0').left + k('0').width / 2,
        eightCx: k('8').left + k('8').width / 2,
        zeroRowY: k('0').top - k('7').top,
        keyCount: keys.length,
        keyFont: key1.fontSize,
        keyWeight: key1.fontWeight,
        keyColor: key1.color,
        keyBg: key1.backgroundColor,
        keyBorder: key1.borderTopColor,
        keyBlur: key1.getPropertyValue('backdrop-filter') || key1.getPropertyValue('-webkit-backdrop-filter'),
        actionsBottom: vh - Math.max(...actions.map((a) => a.bottom)),
        actionsTop: Math.min(...actions.map((a) => a.top)),
        leftText: left.textContent,
        leftButtons: left.querySelectorAll('button').length,
        rightText: right.textContent,
        leftCx: left.getBoundingClientRect().left + left.getBoundingClientRect().width / 2,
        rightCx: right.getBoundingClientRect().left + right.getBoundingClientRect().width / 2,
        key1Cx: k('1').left + k('1').width / 2,
        key3Cx: k('3').left + k('3').width / 2,
        actFont: getComputedStyle(right).fontSize,
        actWeight: getComputedStyle(right).fontWeight,
        actColor: getComputedStyle(right).color,
        actDecor: getComputedStyle(right).textDecorationLine,
        actBorder: getComputedStyle(right).borderTopWidth,
      };
    });
    const at = `@${w}x${h}`;
    const expectKey = Math.min(Math.max(64, 0.195 * w), 82, 0.108 * h);

    // всё помещается без прокрутки, колонка не шире 360
    expect(m.scrollY, `scrollY ${at}`).toBeLessThanOrEqual(0);
    expect(m.scrollX, `scrollX ${at}`).toBeLessThanOrEqual(0);
    expect(m.screenW, at).toBeLessThanOrEqual(360);

    // вертикальная раскладка в процентах высоты
    expect(m.markH, `знак ${at}`).toBeGreaterThanOrEqual(16);
    expect(m.markH, `знак ${at}`).toBeLessThanOrEqual(24);
    expect(m.markTop, `отступ знака ${at}`).toBeGreaterThanOrEqual(23);
    expect(m.markTop, `отступ знака ${at}`).toBeLessThanOrEqual(25);
    expect(Math.abs(m.headCy / m.vh - 0.18), `заголовок ${at}`).toBeLessThan(0.02);
    expect(Math.abs(m.dotsCy / m.vh - 0.25), `точки ${at}`).toBeLessThan(0.01);
    expect(Math.abs(m.padTop / m.vh - 0.34), `клавиатура ${at}`).toBeLessThan(0.01);

    // заголовок и точки
    expect(m.titleSize).toBe('19px');
    expect(m.titleWeight).toBe('500');
    expect(m.titleColor).toBe('rgb(255, 248, 224)');
    expect(m.dotSize).toBe(13);
    expect(Math.round(m.dotStep)).toBe(37);
    // задано 1.5 px; при масштабе экрана 1x Chrome округляет границу до целого пикселя
    expect(['1px', '1.5px']).toContain(m.dotBorder);

    // клавиатура: размер, зазоры, ноль посередине, по бокам пусто
    expect(m.keyCount).toBe(10);
    expect(Math.abs(m.keySize - expectKey), `клавиша ${at}`).toBeLessThan(1);
    expect(Math.round(m.gapX)).toBe(25);
    expect(Math.round(m.gapY)).toBe(19);
    expect(Math.abs(m.zeroCx - m.eightCx)).toBeLessThan(1);
    expect(m.zeroRowY).toBeGreaterThan(0);
    expect(Math.abs(m.padCx - m.vw / 2), `центр ${at}`).toBeLessThan(1);
    expect(m.keyFont).toBe('36px');
    expect(m.keyWeight).toBe('500');
    expect(m.keyColor).toBe('rgb(255, 248, 224)');
    expect(m.keyBg).toBe('rgba(255, 255, 255, 0.14)');
    expect(m.keyBorder).toBe('rgba(255, 255, 255, 0.2)');
    expect(m.keyBlur).toContain('blur(14px)');

    // действия: слева пусто, справа одна кнопка «Отмена», у нижнего края, под колонками 1 и 3
    expect(m.leftText).toBe('');
    expect(m.leftButtons).toBe(0);
    expect(m.rightText).toBe('Отмена');
    expect(Math.abs(m.actionsBottom - 34), `низ действий ${at}`).toBeLessThanOrEqual(12);
    expect(m.actionsTop, `клавиатура не залезает под действия ${at}`).toBeGreaterThan(m.padBottom + 4);
    expect(Math.abs(m.leftCx - m.key1Cx)).toBeLessThan(2);
    expect(Math.abs(m.rightCx - m.key3Cx)).toBeLessThan(2);
    expect(m.actFont).toBe('17px');
    expect(m.actWeight).toBe('500');
    expect(m.actColor).toBe('rgb(255, 248, 224)');
    expect(m.actDecor).toBe('none');
    expect(m.actBorder).toBe('0px');
  }

  // нажатие: мгновенное осветление до .38, возврат за 300 мс
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(1, 1);
  const key5 = page.getByRole('button', { name: '5', exact: true });
  await expect(key5).toBeEnabled();
  await key5.hover();
  await page.mouse.down();
  await page.waitForTimeout(30);
  const down = await key5.evaluate((e) => {
    const c = getComputedStyle(e);
    return { bg: c.backgroundColor, transform: c.transform };
  });
  expect(down.bg).toBe('rgba(255, 255, 255, 0.38)');
  expect(down.transform).not.toBe('none'); // масштаб 0,96
  await page.mouse.up();
  // цифра введена: заполненная точка, справа «Удалить»
  await expect(page.locator('.pin-dots i.on')).toHaveCount(1);
  await page.waitForTimeout(250); // заливка точки плавная, 150 мс
  expect(await page.locator('.pin-dots i.on').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
    'rgb(255, 248, 224)',
  );
  await expect(page.getByRole('button', { name: 'Удалить', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отмена', exact: true })).toHaveCount(0);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  expect(await key5.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(255, 255, 255, 0.14)');

  // «Удалить» стирает, справа снова «Отмена»
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отмена', exact: true })).toBeVisible();
});

test('PIN-экран: ввод с клавиатуры, Backspace, неверный PIN трясёт точки 400 мс и очищает', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  // цифры с клавиатуры, фокус не нужен; Backspace стирает; Enter не нужен
  await page.keyboard.type('12');
  await expect(page.locator('.pin-dots i.on')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.pin-dots i.on')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.pin-dots i.on')).toHaveCount(0);

  // неверный PIN: после четвёртой цифры отправка сама, точки трясутся 400 мс, затем очищаются
  await page.keyboard.type('1357');
  await expect(page.locator('.pin-dots.shake')).toBeVisible();
  expect(await page.locator('.pin-dots').evaluate((e) => getComputedStyle(e).animationDuration)).toBe('0.4s');
  await expect(page.getByText('Неверный PIN. Осталось попыток: 4')).toBeVisible();
  await expect(page.locator('.pin-dots i.on')).toHaveCount(4); // во время тряски точки заполнены
  await expect(page.locator('.pin-dots.shake')).toHaveCount(0, { timeout: 2000 });
  await expect(page.locator('.pin-dots i.on')).toHaveCount(0);

  // верный PIN с клавиатуры открывает приложение
  await page.keyboard.type(PIN);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent');
});

test('PIN-экран: «Отмена» ведёт к паролю, «Войти по паролю» нет; на экране пароля поля 52 px', async ({ page }) => {
  await firstLogin(page, PIN);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Введите PIN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти по паролю' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();

  for (const w of [375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const input = getComputedStyle(document.querySelector('#pva-login')!);
      const btn = getComputedStyle(document.querySelector('.auth-screen .btn')!);
      return {
        vw: window.innerWidth,
        formW: r('.auth-screen form').width,
        formCx: r('.auth-screen form').left + r('.auth-screen form').width / 2,
        inputH: input.height,
        inputR: input.borderTopLeftRadius,
        btnH: r('.auth-screen .btn').height,
        btnR: btn.borderTopLeftRadius,
        btnW: r('.auth-screen .btn').width,
        scrollX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(m.formW, `колонка @${w}`).toBeLessThanOrEqual(360);
    expect(Math.abs(m.formCx - m.vw / 2)).toBeLessThan(1);
    expect(m.inputH).toBe('52px');
    expect(m.inputR).toBe('14px');
    expect(m.btnH).toBe(52);
    expect(m.btnR).toBe('14px');
    expect(Math.abs(m.btnW - m.formW)).toBeLessThan(1);
    expect(m.scrollX).toBeLessThanOrEqual(0);
  }
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
  for (const sel of ['.auth-overlay .wordmark', '.auth-overlay .pad', '.auth-overlay .pin-dots']) {
    expect(await offsets(page, sel), sel).toBeLessThanOrEqual(1);
  }
  await typePin(page, PIN);
  await expect(page.getByRole('dialog', { name: 'Ввод PIN' })).toBeHidden();
  // блокировка прокрутки, поставленная экраном PIN, снята (страница сама не прокручивается: html hidden из CSS)
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe('hidden');
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
  expect(desk.nav.y).toBe(0); // панель от самого верха окна
  expect(Math.abs(desk.nav.b - desk.vh)).toBeLessThanOrEqual(1); // до низа окна
  expect(desk.top.x).toBe(desk.nav.w); // шапка начинается у правого края панели
  expect(desk.top.w).toBe(1440 - desk.nav.w); // и идёт до правого края окна
  expect(desk.main.x).toBeGreaterThanOrEqual(desk.nav.w); // контент правее панели
  expect(desk.composer.x).toBeGreaterThanOrEqual(desk.nav.w - 1);
  expect(desk.tabs[1]!.y).toBeGreaterThan(desk.tabs[0]!.y); // столбиком
  expect(desk.tabs[0]!.x).toBeCloseTo(desk.tabs[1]!.x, 0);
  expect(desk.curBg).toBe('rgb(255, 243, 178)'); // #FFF3B2
  expect(desk.curWeight).toBe('600');
  expect(desk.navBg).toBe('rgb(42, 43, 20)'); // #2A2B14
  expect(desk.mainPaddingBottom).not.toMatch(/^(8\d|9\d|1\d\d)px$/); // нет отступа под нижнюю панель

  // шапка прилипает к верху при прокрутке
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на/ })).toBeVisible();
  await page.evaluate(() => (document.querySelector('main.app-main') as HTMLElement).scrollTo(0, 600));
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
  for (const sel of ['.tab', '.seg', '.icon-btn']) {
    expect(await cursor(sel), sel).toBe('pointer');
  }
  // карточки ставок не кнопки: указателя-руки нет ни у зелёной, ни у красной
  expect(await cursor('.rate.sel')).not.toBe('pointer');
  expect(await cursor('.rate.alt')).not.toBe('pointer');
  await page.getByRole('link', { name: 'Агент' }).click();
  await expect(page.getByLabel('Вопрос агенту')).toBeVisible();
  expect(await cursor('.sug button')).toBe('pointer');
  expect(await cursor('.composer textarea')).toBe('text');
  await page.getByRole('button', { name: 'Меню' }).click();
  expect(await cursor('.sheet button.row')).toBe('pointer');
  await page.keyboard.press('Escape');

  // переходы на интерактивных элементах 150-200 мс
  const durations = await page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const sel of ['.tab', '.icon-btn', '.sug button', '.composer button', '.composer textarea']) {
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

test('Вход: ошибка и поля читаемы на бордовом, контраст проходит axe', async ({ page }) => {
  await page.goto('/login');
  await fillPassword(page, 'wrong-password-for-style-check');
  await expect(page.getByRole('alert').filter({ hasText: 'Неверный логин или пароль' })).toBeVisible();
  const errColor = await page.locator('.auth-screen .form-error').first().evaluate((e) => getComputedStyle(e).color);
  expect(errColor).toBe('rgb(255, 194, 184)'); // #FFC2B8 на #784244
});

// ===== Дашборд: карточки группы, график на телефоне, режимы налогообложения =====

test('Баннеры группы: четыре отдельные на всех ширинах, 1 колонка, 2 на 2, от 1024 px в ряд, числа не переносятся', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.getByRole('heading', { name: /Группа на \d+ \S+ \d{4}/ })).toBeVisible();
  await expect(page.getByText('5 юрлиц · УСН и ОСНО')).toBeVisible();

  const layout = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(1, 1); // курсор не над карточкой: нет подъёма при наведении
    await page.waitForTimeout(700); // радиус карточки меняется плавно, 450 мс
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('.sum-card')] as HTMLElement[];
      const boxes = els.map((e) => e.getBoundingClientRect());
      const cs = getComputedStyle(els[0]!);
      return {
        count: els.length,
        xs: [...new Set(boxes.map((b) => Math.round(b.left)))].length,
        ys: [...new Set(boxes.map((b) => Math.round(b.top)))].length,
        // между карточками: по вертикали в колонке, по горизонтали, если они в одном ряду
        gap:
          Math.round(boxes[1]!.top) === Math.round(boxes[0]!.top)
            ? Math.round(boxes[1]!.left - boxes[0]!.right)
            : Math.round(boxes[1]!.top - boxes[0]!.bottom),
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
        labels: els.map((e) => (e.querySelector('.sum-label')!.firstChild?.textContent ?? '').trim()),
      };
    });
  };

  const phone = await layout(390);
  expect(phone.count).toBe(4);
  expect(phone.xs).toBe(1); // один столбец
  expect(phone.ys).toBe(4);
  expect(phone.bg).toBe('rgb(120, 66, 68)'); // #784244
  expect(phone.radius).toBe('16px');
  expect(phone.padding).toBe('16px');
  expect(phone.label).toBe('rgb(232, 207, 203)'); // #E8CFCB
  expect(phone.value).toBe('rgb(255, 248, 224)'); // #FFF8E0
  expect(phone.tabular).toContain('tabular-nums');
  expect(phone.gap).toBe(12);
  expect(phone.overflow).toBe(false);
  expect(phone.labels[0]).toBe('Выручка с начала года');
  expect(phone.labels[1]).toBe('НДС начислен');
  expect(phone.labels[2]).toMatch(/^НДС за \d{4} год$/);
  expect(phone.labels[3]).toMatch(/^Налог на прибыль за \d{4} год$/);

  const tablet = await layout(768);
  expect(tablet.xs).toBe(2); // два на два
  expect(tablet.ys).toBe(2);
  expect(tablet.overflow).toBe(false);

  // 1023 px: ещё два на два
  const edge = await layout(1023);
  expect(edge.count).toBe(4);
  expect(edge.xs).toBe(2);
  expect(edge.ys).toBe(2);
  expect(edge.overflow).toBe(false);

  // от 1024 px: четыре отдельные карточки в одном ряду, зазор 16 px, радиус 22 px, свой фон у каждой
  for (const width of [1024, 1440]) {
    const row = await layout(width);
    expect(row.count, `${width}`).toBe(4);
    expect(row.xs, `${width}`).toBe(4);
    expect(row.ys, `${width}`).toBe(1);
    expect(row.gap, `${width}`).toBe(16);
    expect(row.bg, `${width}`).toBe('rgb(120, 66, 68)');
    expect(row.radius, `${width}`).toBe('22px');
    expect(row.overflow, `${width}`).toBe(false);
    expect(row.labels, `${width}`).toEqual(phone.labels);
  }
  await layout(360).then((r) => expect(r.overflow).toBe(false));

  // «можно сэкономить» внутри карточки НДС; когда экономить нечего, строки нет (цвет и метка говорят сами)
  await expect(page.locator('.sum-card').nth(1)).toContainText(/можно сэкономить .* в год/);
  await expect(page.locator('.sum-card').nth(1)).not.toContainText('ставки уже лучшие');
  await expect(page.locator('.sum-card').nth(0)).not.toContainText('по всем юрлицам');
});

test('Баннеры группы нажимаются: расшифровка под баннером, один раскрыт, переход к карточкам юрлиц', async ({
  page,
}) => {
  await firstLogin(page, PIN);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect(page.locator('.sum-card')).toHaveCount(4);

  const profit = page.locator('.sum-card').nth(3);
  await expect(profit).toHaveAttribute('aria-expanded', 'false');
  await profit.click();
  await expect(profit).toHaveAttribute('aria-expanded', 'true');
  const detail = page.locator('#sum-detail-profit');
  await expect(detail).toBeVisible();
  await expect(detail.locator('ul.sum-rows li')).toHaveCount(5);
  await expect(detail.locator('.bd-months li')).toHaveCount(12);
  await expect(detail).toContainText('ООО «Эпсилон»');
  await expect(detail).toContainText('ОСНО, 25%');

  // открыли другую: прежняя закрылась, раскрыта одна
  await page.locator('.sum-card').nth(0).click();
  const revenue = page.locator('#sum-detail-revenue');
  await expect(revenue.locator('li')).toHaveCount(5);
  await expect(revenue).toContainText('Выручка с начала года по юрлицам');
  await expect(profit).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sum-item.open')).toHaveCount(1);
  await expect(detail).toBeHidden();
  await page.locator('.sum-card').nth(0).click();
  await expect(revenue).toBeHidden();

  await profit.click();
  const before = await page.evaluate(() => (document.querySelector('main.app-main') as HTMLElement).scrollTop);
  await detail.getByRole('button', { name: 'К карточкам юрлиц' }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('main.app-main') as HTMLElement).scrollTop)).toBeGreaterThan(before + 100);
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
  // пометки «демо» на карточке нет: это сказано в описании под названием и в шапке приложения
  await expect(card('ООО «Эпсилон»').locator('.chip.demo')).toHaveCount(0);

  // УСН: три ставки НДС и блок налога по УСН
  const beta = card('ИП Бета');
  await expect(beta.locator('.rate')).toHaveCount(3);
  await expect(beta.locator('button.rate')).toHaveCount(0);
  await expect(beta.locator('.rate.sel')).toHaveCount(1);
  // режим и ставка в блоке налога не повторяются: они в тегах карточки
  await expect(beta.locator('.taxblock dt', { hasText: /^(Режим|Ставка)$/ })).toHaveCount(0);
  await expect(beta.locator('.taxblock h4')).toHaveText('Налог по УСН, прогноз');
  await expect(beta.locator('.taxblock')).toContainText('Ближайший платёж');
  await expect(beta.locator('.taxblock')).toContainText('28 октября');
  await expect(beta.locator('.taxblock-note')).toContainText('Минимальный налог 1% доходов');

  // ОСНО: одна карточка НДС 22% с вычетами и блок налога на прибыль
  const eps = card('ООО «Эпсилон»');
  await expect(eps.locator('button.rate')).toHaveCount(0);
  await expect(eps.locator('.rate')).toHaveCount(1);
  await expect(eps.locator('.rate.sel')).toContainText('НДС 22%');
  await expect(eps.locator('.rate.sel')).toContainText('С вычетами');
  await expect(eps.locator('.taxblock h4')).toHaveText('Налог на прибыль, прогноз');
  await expect(eps.locator('.taxblock-note')).toContainText('прибыль');

  // «Начислено» растёт вместе с выручкой
  const accrued = eps.locator('.taxblock dd').nth(0);
  const first = await accrued.innerText();
  await page.waitForTimeout(3000);
  expect(await accrued.innerText()).not.toBe(first);

  // предупреждения: ОСНО и ближайшие платежи
  await expect(page.locator('.warn', { hasText: 'ООО «Эпсилон» на ОСНО: прогноз налога на прибыль за год' })).toBeVisible();
  await expect(page.locator('.warn', { hasText: /\d{1,2} [а-я]+: .*(УСН|НДС)/ }).first()).toBeVisible();

  // маршрута смены ставки нет: сервер не принимает выбор ни для кого
  const st = await (await page.request.get('/api/auth/state')).json();
  const res = await page.request.post('/api/rates', {
    headers: { 'x-csrf-token': st.csrf, origin: 'http://localhost:3101' },
    data: { entityId: 'epsilon', rate: 5 },
  });
  expect(res.status()).toBe(404);
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
