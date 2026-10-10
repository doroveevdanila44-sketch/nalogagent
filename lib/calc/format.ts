import { dec, type Dec } from './decimal';
import type { CalendarDay } from './time';

/**
 * Форматирование чисел и дат по-русски. Число типа number появляется только здесь, на выходе в строку.
 * Неразрывный пробел перед «₽» и «млн» не даёт сумме переноситься на другую строку.
 */
const NBSP = ' ';
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0, useGrouping: true });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Num = Dec | string | number;

function realMinus(s: string): string {
  return s.replace(/^-/, '−').replace(/-/g, '−');
}

/** 1 352 381 ₽ */
export function rub(v: Num): string {
  const n = dec(v).toDecimalPlaces(0).toNumber();
  return `${realMinus(nf0.format(n === 0 ? 0 : n))}${NBSP}₽`;
}

/** 1 352 381,27 ₽ */
export function rub2(v: Num): string {
  return `${realMinus(nf2.format(dec(v).toDecimalPlaces(2).toNumber()))}${NBSP}₽`;
}

/** 1,35 млн */
export function mln(v: Num, digits = 1): string {
  const s = dec(v).div(1_000_000).toFixed(digits).replace('.', ',');
  const normalized = /^-0(,0+)?$/.test(s) ? s.slice(1) : s;
  return `${realMinus(normalized)}${NBSP}млн`;
}

/** +0,12 млн, −0,40 млн */
export function signedMln(v: Num, digits = 2): string {
  const d = dec(v);
  return `${d.gt(0) ? '+' : ''}${mln(d, digits)}`;
}

/** 73,6% */
export function pct(share: Num, digits = 0): string {
  return `${dec(share).times(100).toFixed(digits).replace('.', ',')}%`;
}

export const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const;

export const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
] as const;

export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const;

/** 18 декабря */
export function dateRu(d: Pick<CalendarDay, 'month' | 'day'>): string {
  return `${d.day} ${MONTHS_GENITIVE[d.month]}`;
}

/** 10 октября 2026 */
export function dateRuYear(d: CalendarDay): string {
  return `${dateRu(d)} ${d.year}`;
}

/** Склонение: pluralRu(2, 'юрлицо', 'юрлица', 'юрлиц') */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
