import Decimal from 'decimal.js';

/**
 * Единственный конструктор денег в проекте. 40 значащих цифр, округление «половина вверх».
 * Внутри lib/calc сумма никогда не бывает типом number.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Dec = Decimal;

export function dec(v: Decimal.Value): Dec {
  return new D(v);
}

export const ZERO = dec(0);

/** Округление до копеек. Только для вывода и для сумм по группе (см. groupTotal). */
export function round2(v: Dec): Dec {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(values: Dec[]): Dec {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}
