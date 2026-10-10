import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PALETTE } from '@/lib/theme';

/**
 * Временные иконки: «41» цвета бордо на фоне Vistoris Lake (SPEC.md, раздел 6). Цифры нарисованы
 * линиями, шрифт в системе не нужен. Когда клиент даст векторный логотип, заменить SVG здесь.
 */
const BACKGROUND = PALETTE.lake;
const MARK = PALETTE.wine;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BACKGROUND}"/>
  <g fill="none" stroke-width="38" stroke-linecap="butt">
    <path d="M168 140 V292 H300" stroke="${MARK}" stroke-linejoin="miter"/>
    <path d="M262 140 V374" stroke="${MARK}"/>
    <path d="M326 192 L376 142 V374" stroke="${MARK}" stroke-linejoin="bevel"/>
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
