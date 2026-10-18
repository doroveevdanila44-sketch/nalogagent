import { cyr } from './regex';
import type { FleetInput, FleetUnitInput } from '@/lib/calc';

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
const DAYS = cyr('(\\d{1,2})\\s*(?:дн\\w*|ден\\w*|суток)');
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

/** Порядковые слова машин: «первая», «вторую», «третья»... до десятой. */
const ORD_WORD =
  'перв(?:ая|ую|ый|ой|ое)|втор(?:ая|ую|ой|ое)|трет(?:ья|ью|ий|ьей|ье)|четверт(?:ая|ую|ый|ой|ое)|пят(?:ая|ую|ый|ой|ое)|' +
  'шест(?:ая|ую|ой|ое|ый)|седьм(?:ая|ую|ой|ое)|восьм(?:ая|ую|ой|ое)|девят(?:ая|ую|ый|ой|ое)|десят(?:ая|ую|ый|ой|ое)';
const ORD_STEMS = ['перв', 'втор', 'трет', 'четверт', 'пят', 'шест', 'седьм', 'восьм', 'девят', 'десят'];
/** Машина по номеру: «первая», «2-я», «машина 3». Число, за которым деньги или дни, номером не считается. */
const ORD = cyr(
  `(${ORD_WORD})\\b|(\\d{1,2})-?(?:я|ая|ой|ый|й)(?![а-я])|машин\\w*\\s+(?:№\\s*|номер\\s+)?(\\d{1,2})(?!\\s*(?:млн|миллион|тыс|руб|₽|%|р\\b|дн|суток))`,
  'g',
);
const COST_BARE_ANY = cyr('(\\d{1,3}(?: \\d{3})+|\\d{6,})');
/** Конец цены последней названной машины: дальше идёт общее («, сдавать по 9000», «; с ноября»). */
const LAST_CUT = cyr(';|,\\s*(?:сда\\w+|сдач\\w+|аренд\\w+|расход\\w*|с\\s|со\\s|на\\s|по\\s)');

/**
 * Цены по машинам: «первая 3 млн, вторая 5 млн», «машина 1 за 3 млн по 8000 в сутки, машина 2 за 5 млн».
 * Возвращает цены по порядку (пропуски пустыми объектами), число названных машин и текст без разобранных
 * мест. Цена сдачи после последней машины, отделённая запятой, относится ко всем (общая).
 */
function extractUnits(normalized: string): { units: FleetUnitInput[]; rest: string } {
  const marks = [...normalized.matchAll(ORD)].map((m) => {
    const n = m[1] ? ORD_STEMS.findIndex((st) => m[1]!.startsWith(st)) + 1 : Number(m[2] ?? m[3]);
    return { n, start: m.index!, end: m.index! + m[0].length };
  });
  if (marks.length === 0 || marks.some((m) => !(m.n >= 1 && m.n <= 50))) return { units: [], rest: normalized };

  let t = normalized;
  const units: FleetUnitInput[] = [];
  marks.forEach((mk, i) => {
    const isLast = i === marks.length - 1;
    let segEnd = isLast ? t.length : marks[i + 1]!.start;
    if (isLast) {
      const cut = LAST_CUT.exec(t.slice(mk.end));
      if (cut) segEnd = mk.end + cut.index;
    }
    const seg = t.slice(mk.end, segEnd);
    const unit: FleetUnitInput = units[mk.n - 1] ?? {};
    const r = RENT.exec(seg);
    if (r) {
      const v = num(r[1]!) * mult(r[2]);
      if (Number.isFinite(v) && v > 0) unit.rentPerDay = v;
      t = t.slice(0, mk.end + r.index) + ' '.repeat(r[0].length) + t.slice(mk.end + r.index + r[0].length);
    }
    const seg2 = t.slice(mk.end, segEnd);
    const c = COST_UNIT.exec(seg2);
    const bare = c ? null : COST_BARE_ANY.exec(seg2);
    if (c) {
      const v = num(c[1]!) * mult(c[2]);
      if (Number.isFinite(v) && v > 0) unit.cost = v;
      t = t.slice(0, mk.end + c.index) + ' '.repeat(c[0].length) + t.slice(mk.end + c.index + c[0].length);
    } else if (bare) {
      const v = num(bare[1]!);
      if (Number.isFinite(v) && v >= 100_000) unit.cost = v;
      t = t.slice(0, mk.end + bare.index) + ' '.repeat(bare[0].length) + t.slice(mk.end + bare.index + bare[0].length);
    }
    while (units.length < mk.n - 1) units.push({});
    units[mk.n - 1] = unit;
  });
  // ордианалы, не названные ни одной ценой, ничего не дают
  return { units: units.every((u) => Object.keys(u).length === 0) ? [] : units, rest: t };
}

/**
 * Перечень стоимостей через «и» или запятую: «по 3 млн и 5 млн», «по 3 и 5 млн», «по 2, 3 и 5 млн».
 * Единица у числа без своей берётся у ближайшего справа. Любая сумма меньше 100 000 ₽ отменяет разбор
 * (скорее всего это не цены, а число машин). Возвращает стоимости по порядку и текст без перечня.
 */
const LIST_UNIT = '(?:млн|миллион\\w*|тыс\\w*|руб\\w*|₽)';
const COST_LIST = cyr(
  `(?:по|за)\\s+(${NUM}(?:\\s*${LIST_UNIT})?(?:\\s*(?:,|\\s+и)\\s*${NUM}(?:\\s*${LIST_UNIT})?)+)`,
);
const LIST_ITEM = cyr(`${NUM}(?:\\s*(${LIST_UNIT}))?`, 'g');
function extractCostList(t: string): { costs: number[]; rest: string } | null {
  const m = COST_LIST.exec(t);
  if (!m) return null;
  const items = [...m[1]!.matchAll(LIST_ITEM)].map((x) => ({ n: num(x[1]!), unit: x[2] as string | undefined }));
  if (items.length < 2) return null;
  // единица справа налево: «3 и 5 млн» → у тройки тоже млн
  let carry: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.unit) carry = items[i]!.unit;
    else items[i]!.unit = carry;
  }
  const costs = items.map((x) => x.n * mult(x.unit));
  if (costs.some((c) => !Number.isFinite(c) || c < 100_000)) return null;
  return { costs, rest: t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length) };
}

/** Ответ на «Для остальных такая же цена?»: «да, для остальных такая же цена», «указать цену каждой машины». */
const REST_SAME = cyr('(?:для остальн\\w+|остальн\\w+ машин\\w*|остальным)[^.!?]{0,20}(?:такая же|такой же|такие же|так же|одинаков\\w+)|такая же цена для остальн\\w+');
const REST_EACH = cyr('указать (?:цену )?кажд\\w+|кажд\\w+ (?:машин\\w* )?отдельно|разные цены|у каждой своя');
export function restReply(normalized: string): 'same' | 'each' | null {
  if (REST_EACH.test(normalized)) return 'each';
  if (REST_SAME.test(normalized)) return 'same';
  return null;
}

/** Короткое «да» и «нет» на вопрос про остальные машины. */
export const isYes = (normalized: string): boolean => /^(?:да|ага|угу|конечно|ок|окей|верно|точно|так же|такая же)[\s.!,]*$/.test(normalized);
export const isNo = (normalized: string): boolean => /^(?:нет|неа|не такая|разные|по-разному|по разному)[\s.!,]*$/.test(normalized);

/**
 * Что названо в тексте после normalize(). Возвращает только найденные поля; пустой объект:
 * в вопросе нет ни одного значения парка.
 */
export function extractFleet(normalized: string, monthOfWord: (w: string) => number | null): Partial<FleetInput> {
  const out: Partial<FleetInput> = {};
  // цены по машинам («первая 3 млн, вторая 5 млн») разбираются первыми и вырезаются из текста
  const split = extractUnits(normalized);
  if (split.units.length > 0) out.units = split.units;
  let t = split.rest;
  const reply = restReply(normalized);
  if (reply) out.rest = reply;

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

  // стоимости перечислены («по 3 млн и 5 млн»): по машине на каждую, в порядке перечисления
  if (!out.units) {
    const list = extractCostList(t);
    if (list) {
      out.units = list.costs.map((cost) => ({ cost }));
      t = list.rest;
    }
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

/**
 * Значения парка, названные в вопросе, но недопустимые: дни сдачи не от 1 до 31, отрицательная
 * стоимость или цена. Их нельзя молча заменить умолчанием: ответ называет границу.
 */
export function fleetBadValue(normalized: string): string | null {
  const days = DAYS.exec(normalized);
  if (days) {
    const v = Number(days[1]);
    if (v < 1 || v > 31) return 'Дней сдачи в месяц должно быть от 1 до 31.';
  }
  if (cyr('(?:^|\\s)(?:по|за|стоимост\\w*|цен\\w*|сдава\\w*|сдач\\w*)\\s*[-−]\\s*\\d').test(normalized)) {
    return 'Стоимость машины и цена сдачи должны быть больше нуля.';
  }
  return null;
}
