import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PALETTE } from '@/lib/theme';

/**
 * Иконки PWA по дизайн-коду РОБОРАБ v3: лаймовая буква «Р» на фиолетовом фоне. Буква нарисована
 * линиями, шрифт в системе не нужен. Лайм на фиолетовом разрешён (docs/DESIGN.md, раздел 2).
 */
const BACKGROUND = PALETTE.violet;
const MARK = PALETTE.lime;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BACKGROUND}"/>
  <g fill="none" stroke-width="48" stroke-linecap="butt" stroke-linejoin="miter" transform="skewX(-10) translate(46 0)">
    <path d="M178 394 V138 H292 A82 82 0 0 1 292 302 H178" stroke="${MARK}"/>
  </g>
</svg>`;

async function main() {
  const dir = path.resolve(process.cwd(), 'public/icons');
  fs.mkdirSync(dir, { recursive: true });
  const base = Buffer.from(svg);
  const out: [string, number][] = [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ];
  for (const [name, size] of out) {
    await sharp(base).resize(size, size).png().toFile(path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, 'icon.svg'), svg);
  console.log('Иконки созданы в public/icons');
}

main();
