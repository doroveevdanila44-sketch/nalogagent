import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_ENTITIES } from '@/lib/calc/demo-data';
import { ENTITY_COLORS, PALETTE, THEME, entityColor } from './theme';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8');

/** Токены CSS (@theme) и константы TypeScript описывают одну палитру */
const CSS_TOKEN: Record<keyof typeof PALETTE, string> = {
  ink: 'ink',
  muted: 'muted',
  line: 'line',
  page: 'page',
  lake: 'lake',
  lemon: 'lemon',
  accent: 'accent',
  wine: 'wine',
  wineSoft: 'wine-soft',
  wineHover: 'wine-hover',
  wineSub: 'wine-sub',
  cream: 'cream',
  tabIdle: 'tab-idle',
  soft: 'soft',
  mint: 'mint',
  warnInk: 'warn-ink',
  amber: 'amber',
  amberHover: 'amber-hover',
  amberLine: 'amber-line',
};

describe('палитра «Озеро и зелень»', () => {
  it('значения совпадают с заданием', () => {
    expect(PALETTE).toMatchObject({
      ink: '#2A2B14',
      muted: '#6B6A52',
      line: '#E7E5D3',
      page: '#FFFFFF',
      lake: '#A0D2A8',
      lemon: '#FFF3B2',
      accent: '#5A5C2F',
      wine: '#784244',
      wineHover: '#8A4F52',
      wineSub: '#E8CFCB',
      cream: '#FFF8E0',
      tabIdle: '#E3E6C8',
      soft: '#FFF8D6',
      mint: '#EEF6EF',
      warnInk: '#4A3F00',
      amber: '#FFE6A8',
      amberHover: '#FFD986',
      amberLine: '#E6B04A',
    });
  });

  it('токены в app/globals.css совпадают с lib/theme.ts', () => {
    const css = read('app/globals.css');
    for (const [key, name] of Object.entries(CSS_TOKEN)) {
      const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
      expect(m, `нет токена --color-${name}`).not.toBeNull();
      expect(m![1]!.toUpperCase(), `--color-${name}`).toBe(PALETTE[key as keyof typeof PALETTE].toUpperCase());
    }
  });

  it('цвета полосы под часами: озеро в приложении, бордо на входе', () => {
    expect(THEME).toEqual({ app: '#A0D2A8', auth: '#784244' });
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, string>;
    expect(manifest.theme_color).toBe(THEME.app);
    expect(manifest.background_color).toBe(PALETTE.page);
    expect(read('public/offline.html')).toContain(`content="${THEME.app}"`);
  });

  it('иконки PWA: «41» цвета бордо на фоне озера', () => {
    const svg = read('public/icons/icon.svg');
    expect(svg).toContain(`fill="${PALETTE.lake}"`);
    expect(svg.match(new RegExp(`stroke="${PALETTE.wine}"`, 'g'))).toHaveLength(3);
  });

  it('цвета юрлиц: Альфа, Бета, Дельта, Гамма, Эпсилон', () => {
    expect(ENTITY_COLORS).toEqual({
      alfa: '#5A5C2F',
      beta: '#784244',
      delta: '#A0D2A8',
      gamma: '#FFF3B2',
      epsilon: '#2A2B14',
    });
    // сид кладёт в базу те же цвета, интерфейс берёт по id и не зависит от того, обновлена ли база
    for (const e of SEED_ENTITIES) expect(e.color).toBe(ENTITY_COLORS[e.id]);
    expect(entityColor({ id: 'alfa', color: '#000000' })).toBe('#5A5C2F');
    expect(entityColor({ id: 'новое', color: '#123456' })).toBe('#123456');
  });
});

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

describe('контраст текста', () => {
  it('«Договоры · .docx» в окне «Сформировать документ»: не ниже 4,5:1 и в обычном, и в нажатом виде', () => {
    const css = read('app/globals.css');
    const rule = /\.act\.pick small \{[^}]*color:\s*var\(--color-([a-z-]+)\)/.exec(css);
    expect(rule, 'правило .act.pick small').not.toBeNull();
    const token = rule![1]!;
    const hex = (name: string) => {
      const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
      expect(m, `токен ${name}`).not.toBeNull();
      return m![1]!;
    };
    // кнопка бордовая, при наведении и нажатии на тон светлее
    for (const bg of ['wine', 'wine-hover']) {
      expect(contrast(hex(token), hex(bg)), `${token} на ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // прежний цвет второй строки (приглушённый) этого условия не выдерживал
    expect(contrast(PALETTE.muted, PALETTE.wine)).toBeLessThan(4.5);
  });

  it('текст подсказок «Что если» на янтарном фоне читается', () => {
    expect(contrast(PALETTE.ink, PALETTE.amber)).toBeGreaterThanOrEqual(7);
    expect(contrast(PALETTE.ink, PALETTE.amberHover)).toBeGreaterThanOrEqual(7);
  });
});

describe('полоса под часами и шапка', () => {
  const css = read('app/globals.css');
  const rule = (selector: string): string => {
    const m = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, `правило ${selector}`).not.toBeNull();
    return m![1]!;
  };

  it('шапка, html и body в приложении берут цвет из одной переменной --bar, это цвет шапки', () => {
    expect(css).toMatch(/--bar:\s*var\(--color-lake\)/);
    for (const sel of ['html', 'body', '.top']) {
      expect(rule(sel), sel).toMatch(/background:\s*var\(--bar\)/);
    }
  });

  it('у шапки свой padding-top под вырез и часы', () => {
    expect(rule('.top')).toMatch(/padding-top:\s*env\(safe-area-inset-top/);
  });

  it('на экранах входа и PIN html и body бордовые, а страница приложения белая', () => {
    expect(css).toMatch(/html:has\(\.auth-screen\),\s*html:has\(\.auth-screen\) body \{\s*background:\s*var\(--color-wine\)/);
    expect(rule('.app-shell')).toMatch(/background:\s*var\(--color-page\)/);
  });

  it('режим отображения не влияет на цвета: в стилях нет правил для display-mode (установленное приложение красится так же)', () => {
    expect(css).not.toMatch(/display-mode/);
    // манифест просит именно установленное приложение, а цвет шапки в нём тот же, что у страницы
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, string>;
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe(PALETTE.lake);
  });

  it('theme-color по маршруту: приложение цвет шапки, вход бордо; манифест цвет шапки', () => {
    const app = read('app/(app)/layout.tsx');
    const login = read('app/(public)/login/page.tsx');
    expect(app).toMatch(/viewport: Viewport = \{ themeColor: THEME\.app \}/);
    expect(login).toMatch(/viewport: Viewport = \{ themeColor: THEME\.auth \}/);
    expect(THEME.app).toBe(PALETTE.lake);
    expect(THEME.auth).toBe(PALETTE.wine);
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, string>;
    expect(manifest.theme_color).toBe(PALETTE.lake);
  });
});

