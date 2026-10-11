import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Охранный тест документов. Пять файлов в docs/ однажды стали пустыми одной операцией и попали в
 * коммит (причина в docs/DECISIONS.md, раздел «Документы»). Тест не даёт этому повториться
 * незамеченным: пустой, обрезанный или заменённый документ роняет `npm test`.
 */
const DOCS = path.resolve(process.cwd(), 'docs');

/** Документы пакета: .md и schema.sql на верхнем уровне docs/. Прототип в docs/reference не входит. */
const FILES = fs
  .readdirSync(DOCS)
  .filter((f) => f.endsWith('.md') || f === 'schema.sql')
  .sort();

/** Документы, которые обязаны существовать: на них ссылаются README, код и друг друга. */
const REQUIRED = [
  'README.md',
  'SPEC.md',
  'AUTH.md',
  'CALC.md',
  'AGENT.md',
  'PROMPTS.md',
  'DECISIONS.md',
  'DEPLOY.md',
  'OPEN_QUESTIONS.md',
  'HANDOFF.md',
  'schema.sql',
];

/** Минимальный размер документа в байтах: короче это обнулённый или почти пустой файл. */
const MIN_BYTES = 200;

/**
 * Значения прежней палитры (до «Озера и зелени»). Это только те, которых нет в нынешней палитре:
 * общие для обеих (состояния `#1D7A4B`, `#B3372B` и другие) сюда не входят.
 */
const OLD_HEX = [
  '#13191F', '#2B2F2E', '#3F362B', '#4A3418', '#594C3D', '#695C4D', '#6E5238', '#75665A', '#906D4B',
  '#CA9C68', '#D9C7AE', '#E3D2BC', '#E7D2B5', '#E9D9C3', '#E9E1D6', '#EFE9E1', '#F6EBDD', '#F6EEE2',
];
const OLD_NAMES = ['River Styx', 'Carbon Fibre', 'Afternoon Tea', 'Tanned Wood', 'Amber Autumn'];

/** История решений хранит прежнюю палитру как «было»: её не переписывают. */
const HISTORY = new Set(['DECISIONS.md']);

const read = (f: string) => fs.readFileSync(path.join(DOCS, f), 'utf8');

/** Длинные тире с U+2012 по U+2015 (цифровое, среднее, длинное, горизонтальная черта). Минус U+2212 допустим. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2012)}-${String.fromCharCode(0x2015)}]`);

describe('документы в docs/ целы', () => {
  it('все обязательные документы на месте', () => {
    const missing = REQUIRED.filter((f) => !FILES.includes(f));
    expect(missing).toEqual([]);
  });

  for (const file of FILES) {
    describe(file, () => {
      it(`не короче ${MIN_BYTES} байт`, () => {
        const size = fs.statSync(path.join(DOCS, file)).size;
        expect(size, `${file}: ${size} байт`).toBeGreaterThanOrEqual(MIN_BYTES);
      });

      it('заканчивается переводом строки', () => {
        expect(read(file).endsWith('\n'), `${file} оборван без перевода строки`).toBe(true);
      });

      it('ограждений кода чётное число (нет оборванного блока)', () => {
        const fences = read(file)
          .split('\n')
          .filter((line) => /^\s*(```|~~~)/.test(line)).length;
        expect(fences % 2, `${file}: ограждений ${fences}`).toBe(0);
      });

      it('нет длинных тире', () => {
        expect(LONG_DASH.test(read(file)), `${file}: длинное тире`).toBe(false);
      });

      if (!HISTORY.has(file)) {
        it('нет значений и названий прежней палитры', () => {
          const text = read(file);
          const found = [
            ...OLD_HEX.filter((h) => text.toUpperCase().includes(h)),
            ...OLD_NAMES.filter((n) => text.toLowerCase().includes(n.toLowerCase())),
          ];
          expect(found, `${file}: прежняя палитра`).toEqual([]);
        });
      }
    });
  }

  it('значения прежней палитры не совпадают с нынешней (список не устарел)', () => {
    // нынешняя палитра берётся из токенов, прежние значения не должны в ней встречаться
    const css = fs.readFileSync(path.resolve(process.cwd(), 'app/globals.css'), 'utf8').toUpperCase();
    const stale = OLD_HEX.filter((h) => css.includes(h));
    expect(stale).toEqual([]);
  });
});
