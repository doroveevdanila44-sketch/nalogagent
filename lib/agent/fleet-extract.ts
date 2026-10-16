import { cyr } from './regex';
import type { FleetInput } from '@/lib/calc';

/**
 * Значения парка машин из текста вопроса («купим 3 машины по 4 млн, сдавать по 9000 в сутки»).
 * Правила заглушки: достаёт только то, что названо явно, ничего не додумывает. Недостающее
 * спрашивает карточка в чате. Числа здесь только разобраны из текста, не посчитаны.
 */

const NUM = '(\\d{1,3}(?: \\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)';
const UNIT = '(млн|миллион\\w*|тыс\\w*|руб\\w*|₽|р\\b)?';

/** Цена сдачи: «по 9000 в сутки», «9 тыс в день», «8 000 ₽/сутки». */
const RENT = cyr(`${NUM}\\s*${UNIT}\\s*(?:в|за|/)\\s*(?:сутки|сут\\b|день|дн\\b)`);
/** Расходы: «расходы 20 тыс в месяц», «страховка по 5000», «лизинг 40 000». */
const EXPENSES = cyr(
  `(?:расход\\w*|затрат\\w*|лизинг\\w*|страховк\\w*|обслуживани\\w*)(?:\\s+на\\s+(?:машин\\w*|авто\\w*|каждую|одну))?[^\\d]{0,12}?${NUM}\\s*${UNIT}`,
);
/** Дни сдачи в месяц: «20 дней», «сдавать 15 дней в месяц». */
const DAYS = cyr('(\\d{1,2})\\s*(?:дн\\w*|суток)');
/** Стоимость: число с единицей («4 млн», «3,5 миллиона», «4 000 000 руб»). */
const COST_UNIT = cyr(`${NUM}\\s*(млн|миллион\\w*|тыс\\w*|руб\\w*|₽|р\\b)`);
/** Стоимость голым числом после «по»: «по 4000000». Только от 100 000, чтобы не принять число машин. */
const COST_BARE = cyr(`\\bпо\\s+${NUM}(?!\\s*(?:%|машин|авто|дн|шт))`);
/** С НДС или без НДС названо явно. */
const WITHOUT_VAT = cyr('\\bбез\\s+ндс\\b|\\bплюс\\s+ндс\\b|\\+\\s*ндс\\b|\\bндс\\s+сверху\\b');
const WITH_VAT = cyr('(?:^|\\s)(?:с|включая|вкл\\.?|вместе\\s+с)\\s+ндс\\b|\\bндс\\s+включ\\w*|\\bндс\\s+вкл\\b');
/** «Сдавать», «сдача», «аренда»: в вопросе речь о сдаче машин. */
export const RENT_WORD = cyr('сда\\w+|сдач\\w+|аренд\\w+|в сутки|за сутки|в день');
/** Машина в вопросе: без неё «купим» может быть чем угодно. */
export const CAR_WORD = cyr('машин\\w*|авто\\b|авто\\w+|автомобил\\w*|транспорт\\w*');

const num = (s: string): number => Number(s.replace(/ /g, '').replace(',', '.'));

const mult = (unit: string | undefined): number => {
  if (!unit) return 1;
  if (/^(?:млн|миллион)/.test(unit)) return 1_000_000;
  if (/^тыс/.test(unit)) return 1_000;
  return 1;
};

const blank = (t: string, m: RegExpExecArray): string =>
  t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length);

/** Цена сдачи в вопросе названа («в сутки», «в день» с числом). */
export function mentionsRentPrice(normalized: string): boolean {
  return RENT.test(normalized);
}

/**
 * Что названо в тексте после normalize(). Возвращает только найденные поля; пустой объект:
 * в вопросе нет ни одного значения парка.
 */
export function extractFleet(normalized: string, monthOfWord: (w: string) => number | null): Partial<FleetInput> {
  const out: Partial<FleetInput> = {};
  let t = normalized;

  const rent = RENT.exec(t);
  if (rent) {
    const v = num(rent[1]!) * mult(rent[2]);
    if (Number.isFinite(v) && v > 0) out.rentPerDay = v;
    t = blank(t, rent);
  }

  const exp = EXPENSES.exec(t);
  if (exp) {
    const v = num(exp[1]!) * mult(exp[2]);
    if (Number.isFinite(v) && v >= 0) out.expensesPerMonth = v;
    t = blank(t, exp);
  }

  const days = DAYS.exec(t);
  if (days) {
    const v = Number(days[1]);
    if (v >= 1 && v <= 31) out.rentDays = v;
    t = blank(t, days);
  }

  // НДС: явное «без НДС» сильнее «с НДС»
  if (WITHOUT_VAT.test(t)) out.costWithVat = false;
  else if (WITH_VAT.test(t)) out.costWithVat = true;

  const cost = COST_UNIT.exec(t);
  if (cost) {
    const v = num(cost[1]!) * mult(cost[2]);
    if (Number.isFinite(v) && v > 0) out.cost = v;
  } else {
    const bare = COST_BARE.exec(t);
    const v = bare ? num(bare[1]!) : NaN;
    if (Number.isFinite(v) && v >= 100_000) out.cost = v;
  }

  // месяц начала: «с ноября», «начиная с января»
  for (const m of t.matchAll(/(?:^|\s)со?\s+([а-я]+\.?)/g)) {
    const month = monthOfWord(m[1]!);
    if (month !== null) {
      out.startMonth = month - 1;
      break;
    }
  }
  return out;
}
