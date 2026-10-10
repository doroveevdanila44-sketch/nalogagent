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
  wineSub: 'wine-sub',
  cream: 'cream',
  tabIdle: 'tab-idle',
  soft: 'soft',
  mint: 'mint',
  warnInk: 'warn-ink',
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
      wineSub: '#E8CFCB',
      cream: '#FFF8E0',
      tabIdle: '#E3E6C8',
      soft: '#FFF8D6',
      mint: '#EEF6EF',
      warnInk: '#4A3F00',
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
