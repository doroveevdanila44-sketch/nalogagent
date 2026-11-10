import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_ENTITIES } from '@/lib/calc/demo-data';
import { ENTITY_COLORS, PALETTE, THEME, entityColor } from './theme';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8');
const shellCss = read('app/roborab-ui.css');

/** Токены CSS (@theme), у которых в дизайн-коде РОБОРАБ v3 есть сплошной HEX */
const CSS_HEX_TOKEN = {
  violet: 'violet',
  deep: 'deep',
  ink: 'ink',
  lime: 'lime',
  bg: 'bg',
  white: 'white',
  bblue: 'bblue',
  sky: 'sky',
} as const satisfies Partial<Record<keyof typeof PALETTE, string>>;

/** Производные прозрачности: в CSS это rgb(... / alpha), в файлах Excel и Word сплошной цвет на белом */
const CSS_ALPHA_TOKEN = { mute: 'mute', line: 'line', soft: 'soft' } as const;

/** Относительная яркость и контраст по WCAG 2.1. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('палитра РОБОРАБ v3', () => {
  it('значения совпадают с docs/DESIGN.md', () => {
    expect(PALETTE).toMatchObject({
      violet: '#141414',
      deep: '#232323',
      ink: '#141414',
      lime: '#4DA3FF',
      bg: '#F4F4F2',
      white: '#FFFFFF',
      bblue: '#0957E8',
      sky: '#5AA9FF',
    });
  });

  it('токены в app/globals.css совпадают с lib/theme.ts', () => {
    const css = read('app/globals.css');
    for (const [key, name] of Object.entries(CSS_HEX_TOKEN)) {
      const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
      expect(m, `нет токена --color-${name}`).not.toBeNull();
      expect(m![1]!.toUpperCase(), `--color-${name}`).toBe(PALETTE[key as keyof typeof CSS_HEX_TOKEN].toUpperCase());
    }
  });

  it('производные mute, line, soft: rgb с прозрачностью в CSS равен сплошному цвету на белом в lib/theme.ts', () => {
    const css = read('app/globals.css');
    const ALPHA = { mute: 0.64, line: 0.12, soft: 0.07 } as const;
    const BASE = { mute: [20, 20, 20], line: [20, 20, 20], soft: [10, 132, 255] } as const;
    for (const [key, name] of Object.entries(CSS_ALPHA_TOKEN)) {
      const m = css.match(new RegExp(`--color-${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([0-9.]+)\\)`));
      expect(m, `нет токена --color-${name}`).not.toBeNull();
      const [r, g, b] = [m![1], m![2], m![3]].map(Number);
      const a = Number(m![4]);
      expect([r, g, b], name).toEqual([...BASE[key as keyof typeof BASE]]);
      expect(a, name).toBe(ALPHA[key as keyof typeof ALPHA]);
      const flat = [r!, g!, b!].map((c) => Math.round(255 - (255 - c) * a));
      const hex = `#${flat.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
      expect(PALETTE[key as keyof typeof CSS_ALPHA_TOKEN].toUpperCase(), name).toBe(hex);
    }
  });

  it('в стилях нет токенов прежней палитры «Озеро и зелень»', () => {
    const css = read('app/globals.css');
    for (const old of ['lake', 'lemon', 'wine', 'cream', 'accent', 'mint', 'amber', 'tab-idle']) {
      expect(css, `--color-${old}`).not.toMatch(new RegExp(`--color-${old}\\b`));
    }
  });

  it('цвета юрлиц: Альфа, Бета, Дельта, Гамма, Эпсилон', () => {
    expect(ENTITY_COLORS).toEqual({
      alfa: '#141414',
      beta: '#4DA3FF',
      delta: '#5AA9FF',
      gamma: '#141414',
      epsilon: '#0957E8',
    });
    // сид кладёт в базу те же цвета, интерфейс берёт по id и не зависит от того, обновлена ли база
    for (const e of SEED_ENTITIES) expect(e.color).toBe(ENTITY_COLORS[e.id]);
    expect(entityColor({ id: 'alfa', color: '#000000' })).toBe('#141414');
    expect(entityColor({ id: 'новое', color: '#123456' })).toBe('#123456');
  });
});

describe('контраст по правилам применения цвета (DESIGN.md, раздел 2)', () => {
  it('белый текст на фиолетовом и индиго не ниже 4,5:1', () => {
    expect(contrast(PALETTE.white, PALETTE.violet)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.white, PALETTE.deep)).toBeGreaterThanOrEqual(4.5);
  });

  it('ink на лайме не ниже 7:1', () => {
    expect(contrast(PALETTE.ink, PALETTE.lime)).toBeGreaterThanOrEqual(7);
  });

  it('лаймовый текст читается на тёмных фонах: deep, ink, violet', () => {
    for (const bg of [PALETTE.deep, PALETTE.ink, PALETTE.violet]) {
      expect(contrast(PALETTE.lime, bg), `лайм на ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('лайм на светлом фоне нечитаем, поэтому им набирают только фон: контраст лайма на bg и белом ниже 3:1', () => {
    expect(contrast(PALETTE.lime, PALETTE.bg)).toBeLessThan(3);
    expect(contrast(PALETTE.lime, PALETTE.white)).toBeLessThan(3);
  });

  it('фиолетовый текст на bg и белом не ниже 4,5:1', () => {
    expect(contrast(PALETTE.violet, PALETTE.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.violet, PALETTE.white)).toBeGreaterThanOrEqual(4.5);
  });

  it('второстепенный текст mute на белом и bg не ниже 4,5:1', () => {
    expect(contrast(PALETTE.mute, PALETTE.white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.mute, PALETTE.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('«Договоры · .docx» в окне «Сформировать документ»: белый на фиолетовом и лайме ink не ниже 4,5:1', () => {
    const css = read('app/globals.css');
    const rule = /\.act\.pick small \{[^}]*color:\s*var\(--color-([a-z-]+)\)/.exec(css);
    expect(rule, 'правило .act.pick small').not.toBeNull();
    expect(rule![1]).toBe('white');
    expect(contrast(PALETTE.white, PALETTE.violet)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('полоса под часами и шапка', () => {
  const css = read('app/globals.css');
  const rule = (selector: string): string => {
    const m = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, `правило ${selector}`).not.toBeNull();
    return m![1]!;
  };

  it('общая фиолетовая шапка со скруглением снизу, html и body в приложении светлые', () => {
    expect(shellCss).toMatch(/--rr-violet:\s*#141414/i);
    expect(shellCss).toMatch(/--rr-header-radius:\s*28px/);
    expect(shellCss).toMatch(/\.rr-header\s*\{[^}]*background:\s*var\(--rr-violet\)/);
    expect(read('components/AppShell.tsx')).not.toContain('top-title');
    for (const sel of ['html', 'body']) {
      expect(rule(sel), sel).toMatch(/background:\s*var\(--color-bg\)/);
    }
  });

  it('у шапки свой padding-top под вырез и часы', () => {
    expect(shellCss).toMatch(/\.rr-header\s*\{[^}]*padding-block-start:\s*var\(--rr-safe-top\)/);
  });

  it('на экранах входа и PIN html и body фиолетовые, а страница приложения лиловая (--bg)', () => {
    expect(css).toMatch(/html:has\(\.auth-screen\),\s*html:has\(\.auth-screen\) body \{\s*background:\s*var\(--color-violet\)/);
    expect(rule('.app-viewport')).toMatch(/background:\s*var\(--color-bg\)/);
  });

  it('режим отображения не влияет на цвета: в стилях нет правил для display-mode (установленное приложение красится так же)', () => {
    expect(css).not.toMatch(/display-mode/);
    // манифест просит именно установленное приложение, а цвет шапки в нём тот же, что у страницы
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, string>;
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe(PALETTE.violet);
    expect(manifest.background_color).toBe(PALETTE.bg);
  });

  it('theme-color по маршруту и в манифесте: фиолетовый, цвет шапки', () => {
    const app = read('app/(app)/layout.tsx');
    const login = read('app/(public)/login/page.tsx');
    expect(app).toMatch(/viewport: Viewport = \{ themeColor: THEME\.app \}/);
    expect(login).toMatch(/viewport: Viewport = \{ themeColor: THEME\.auth \}/);
    expect(THEME).toEqual({ app: PALETTE.violet, auth: PALETTE.violet });
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, string>;
    expect(manifest.theme_color).toBe(PALETTE.violet);
    expect(read('public/offline.html')).toContain(`content="${THEME.app}"`);
  });

  it('иконки PWA: лаймовая «Р» на фиолетовом', () => {
    const svg = read('public/icons/icon.svg');
    expect(svg).toContain(`fill="${PALETTE.violet}"`);
    expect(svg).toContain(`stroke="${PALETTE.lime}"`);
  });
});

describe('шрифты и функциональный текст (DESIGN.md, разделы 3 и 10.1)', () => {
  const css = read('app/globals.css');
  const layout = read('app/layout.tsx');

  it('подключены Montserrat и Manrope, прежних шрифтов нет', () => {
    expect(layout).toMatch(/Montserrat/);
    expect(layout).toMatch(/Manrope/);
    expect(layout).not.toMatch(/Onest|Orbitron/);
    expect(read('components/Wordmark.tsx')).not.toMatch(/Orbitron/);
    expect(css).toMatch(/--font-display:[^;]*Montserrat/);
    expect(css).toMatch(/--font-sans:[^;]*Manrope/);
  });

  it('H1, H2, H3 курсивные, остальной функциональный текст прямой', () => {
    const heads = /h1,\s*h2,\s*h3 \{([^}]*)\}/.exec(css);
    expect(heads, 'правило заголовков').not.toBeNull();
    expect(heads![1]).toMatch(/font-style:\s*italic/);
    // кнопки, метки, вкладки, пункты меню, чипы: font-style normal
    const group = /\.btn,\s*\.act,[^{]*\{([^}]*)\}/.exec(css);
    expect(group, 'правило функционального текста').not.toBeNull();
    expect(group![1]).toMatch(/font-style:\s*normal/);
    expect(group![1]).toMatch(/font-weight:\s*800/);
    for (const sel of ['.btn', '.tab', '.chip', '.pill', '.eyebrow', '.sheet button.row', '.menu-item', '.filter']) {
      expect(group![0], sel).toContain(sel);
    }
  });
});

describe('форма и поверхности (DESIGN.md, раздел 4)', () => {
  const css = read('app/globals.css');

  it('нет цветных теней и свечений: тень только нейтральная чёрная, остальное жёсткие кольца без размытия', () => {
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    for (const sh of shadows) {
      if (sh === 'none') continue;
      const ok =
        // нейтральная серая тень всплывающего слоя
        /^0 \d+px \d+px -?\d+px rgb\(0 0 0 \/ [0-9.]+\)$/.test(sh) ||
        // жёсткое кольцо без размытия (обводка открытой карточки)
        /^(inset )?0 0 0 \d+px var\(--color-[a-z-]+\)$/.test(sh) ||
        // затемнение остального экрана под подсказкой обучения
        /^0 0 0 9999px color-mix\(in srgb, var\(--color-ink\) \d+%, transparent\)$/.test(sh);
      expect(ok, `тень «${sh}»`).toBe(true);
    }
    expect(css).not.toMatch(/drop-shadow|text-shadow|(?<!backdrop-)filter:\s*blur/);
  });

  it('кнопки, метки и вкладки круглые, поля формы 20 px', () => {
    for (const sel of ['.btn', '.act', '.chip', '.pill']) {
      const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, sel).not.toBeNull();
      expect(m![1], sel).toMatch(/border-radius:\s*(?:999px|var\(--rr-control-radius\))/);
    }
    expect(shellCss).toMatch(/\.rr-composer \.rr-composer-control \{[^}]*border-radius:\s*50%/);
    const field = /\n\s*\.field input \{([^}]*)\}/.exec(css);
    expect(field![1]).toMatch(/border-radius:\s*20px/);
  });

  it('тачбар на телефоне: плитки высотой 68 px со стеклом, отступ 16 px, только иконки', () => {
    expect(shellCss).toMatch(/--rr-dock-size:\s*68px/);
    expect(shellCss).toMatch(/--rr-dock-inset:\s*16px/);
    expect(shellCss).toMatch(/--rr-glass-filter:\s*blur\(20px\) saturate\(1\.7\)/);
    expect(shellCss).toMatch(/rgb\(255 255 255 \/ 0\.5\)/);
    expect(shellCss).toMatch(/--rr-glass-active-fill:\s*rgb\(255 255 255 \/ 0\.94\)/);
    expect(shellCss).toMatch(/\.rr-tab-label \{[^}]*clip-path:\s*inset\(50%\)/);
    expect(css).toMatch(/--tabs-h:\s*var\(--rr-dock-space\)/);
  });
});
