import { dec, type Dec } from './decimal';
import { MONTHS_GENITIVE } from './format';
import { daysInMonth, toIsoDate, type Moment } from './time';

/**
 * Период расчёта. Месяцы здесь нумеруются по-человечески, 1..12 (в отличие от Moment и CalendarDay,
 * где месяц 0..11). Границы диапазона задаются датами YYYY-MM-DD включительно.
 *
 *  month    один календарный месяц
 *  quarter  календарный квартал 1..4
 *  year     календарный год
 *  ytd      с начала года по сегодняшний момент (год берётся из «сегодня»)
 *  range    произвольный диапазон дат; месяц, захваченный частично, берётся долей по дням
 */
export type Period =
  | { kind: 'month'; year: number; month: number }
  | { kind: 'quarter'; year: number; quarter: number }
  | { kind: 'year'; year: number }
  | { kind: 'ytd' }
  | { kind: 'range'; from: string; to: string };

/** Состояние месяца относительно «сегодня»: прошёл, идёт, ещё впереди. */
export type MonthStatus = 'fact' | 'partial' | 'forecast';

/** Итог по периоду: все месяцы факт, все прогноз или смесь (в том числе идущий месяц). */
export type PeriodKind = 'fact' | 'forecast' | 'mixed';

export interface ResolvedMonth {
  year: number;
  /** 1..12 */
  month: number;
  /** 2026-03 */
  key: string;
  /** Первый и последний день части месяца, вошедшей в период (YYYY-MM-DD) */
  from: string;
  to: string;
  /** Сколько дней месяца вошло в период. Дробное число только у идущего месяца в ytd */
  coveredDays: Dec;
  daysInMonth: number;
  /** coveredDays / daysInMonth, от 0 (исключительно) до 1 */
  coverage: Dec;
  status: MonthStatus;
}

export interface ResolvedPeriod {
  period: Period;
  /** «февраль 2026» */
  label: string;
  /** Границы, включительно */
  from: string;
  to: string;
  months: ResolvedMonth[];
  kind: PeriodKind;
}

export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodError';
  }
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const pad = (n: number) => String(n).padStart(2, '0');

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

/** Номер месяца в общей шкале, чтобы сравнивать (год, месяц) обычным числом. */
function ordinal(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function validYear(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
}

function checkYear(year: number): void {
  if (!validYear(year)) throw new PeriodError(`Год вне диапазона ${MIN_YEAR}..${MAX_YEAR}: ${year}`);
}

function checkMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new PeriodError(`Месяц должен быть от 1 до 12: ${month}`);
  }
}

function checkQuarter(quarter: number): void {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new PeriodError(`Квартал должен быть от 1 до 4: ${quarter}`);
  }
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function validYmd(y: Ymd): boolean {
  return (
    validYear(y.year) &&
    Number.isInteger(y.month) &&
    y.month >= 1 &&
    y.month <= 12 &&
    Number.isInteger(y.day) &&
    y.day >= 1 &&
    y.day <= daysInMonth(y.year, y.month - 1)
  );
}

function isoOf(y: Ymd): string {
  return `${y.year}-${pad(y.month)}-${pad(y.day)}`;
}

function parseIso(s: string): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ymd = m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
  if (!ymd || !validYmd(ymd)) throw new PeriodError(`Нужна существующая дата вида YYYY-MM-DD: ${s}`);
  return ymd;
}

/** Состояние месяца (год, месяц 1..12) относительно «сегодня». */
export function monthStatus(year: number, month: number, today: Moment): MonthStatus {
  const diff = ordinal(year, month) - ordinal(today.year, today.month + 1);
  return diff < 0 ? 'fact' : diff === 0 ? 'partial' : 'forecast';
}

/** Сводит признаки месяцев в признак периода. Идущий месяц делает период смешанным. */
export function periodKindOf(statuses: MonthStatus[]): PeriodKind {
  if (statuses.length === 0) return 'forecast';
  if (statuses.every((s) => s === 'fact')) return 'fact';
  if (statuses.every((s) => s === 'forecast')) return 'forecast';
  return 'mixed';
}

function wholeMonth(year: number, month: number, today: Moment): ResolvedMonth {
  const n = daysInMonth(year, month - 1);
  return {
    year,
    month,
    key: monthKey(year, month),
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(n)}`,
    coveredDays: dec(n),
    daysInMonth: n,
    coverage: dec(1),
    status: monthStatus(year, month, today),
  };
}

function monthsBetween(from: Ymd, to: Ymd, today: Moment): ResolvedMonth[] {
  const out: ResolvedMonth[] = [];
  let y = from.year;
  let m = from.month;
  while (ordinal(y, m) <= ordinal(to.year, to.month)) {
    const n = daysInMonth(y, m - 1);
    const first = y === from.year && m === from.month ? from.day : 1;
    const last = y === to.year && m === to.month ? to.day : n;
    const covered = last - first + 1;
    out.push({
      year: y,
      month: m,
      key: monthKey(y, m),
      from: `${y}-${pad(m)}-${pad(first)}`,
      to: `${y}-${pad(m)}-${pad(last)}`,
      coveredDays: dec(covered),
      daysInMonth: n,
      coverage: dec(covered).div(n),
      status: monthStatus(y, m, today),
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Границы периода и признак каждого месяца относительно `today`:
 *  fact      месяц целиком в прошлом
 *  partial   идущий месяц (частично факт)
 *  forecast  месяц впереди
 *
 * ytd считает идущий месяц тем же способом, что накопление на дашборде: прошедшие дни плюс доля
 * текущих суток по секундам, поэтому «с начала года» совпадает с ytd() калькулятора.
 */
export function resolvePeriod(period: Period, today: Moment): ResolvedPeriod {
  const label = formatPeriod(period);
  switch (period.kind) {
    case 'month': {
      const m = wholeMonth(period.year, period.month, today);
      return { period, label, from: m.from, to: m.to, months: [m], kind: periodKindOf([m.status]) };
    }
    case 'quarter': {
      const first = (period.quarter - 1) * 3 + 1;
      const months = [0, 1, 2].map((k) => wholeMonth(period.year, first + k, today));
      return {
        period,
        label,
        from: months[0]!.from,
        to: months[2]!.to,
        months,
        kind: periodKindOf(months.map((m) => m.status)),
      };
    }
    case 'year': {
      const months = Array.from({ length: 12 }, (_, i) => wholeMonth(period.year, i + 1, today));
      return {
        period,
        label,
        from: `${period.year}-01-01`,
        to: `${period.year}-12-31`,
        months,
        kind: periodKindOf(months.map((m) => m.status)),
      };
    }
    case 'ytd': {
      const cur = today.month + 1;
      const months: ResolvedMonth[] = [];
      for (let m = 1; m < cur; m++) months.push(wholeMonth(today.year, m, today));
      // идущий месяц: прошедшие дни и доля суток, как в frac() и ytd()
      const past = dec(today.day - 1).plus(dec(today.secondsOfDay).div(86400));
      if (!past.isZero()) {
        const n = daysInMonth(today.year, today.month);
        months.push({
          year: today.year,
          month: cur,
          key: monthKey(today.year, cur),
          from: `${today.year}-${pad(cur)}-01`,
          to: `${today.year}-${pad(cur)}-${pad(today.day)}`,
          coveredDays: past,
          daysInMonth: n,
          coverage: past.div(n),
          status: 'partial',
        });
      }
      const to = toIsoDate({ year: today.year, month: today.month, day: today.day });
      return {
        period,
        label,
        from: `${today.year}-01-01`,
        to,
        months,
        kind: periodKindOf(months.map((m) => m.status)),
      };
    }
    case 'range': {
      const from = parseIso(period.from);
      const to = parseIso(period.to);
      if (isoOf(from) > isoOf(to)) {
        throw new PeriodError(`Начало периода позже конца: ${period.from} .. ${period.to}`);
      }
      const months = monthsBetween(from, to, today);
      return {
        period,
        label,
        from: isoOf(from),
        to: isoOf(to),
        months,
        kind: periodKindOf(months.map((m) => m.status)),
      };
    }
  }
}

// ===== Форматирование по-русски =====

/** Месяцы в именительном падеже, строчными: «февраль». */
export const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
] as const;

/** В предложном падеже: «в феврале». */
export const MONTHS_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
] as const;

/**
 * Диапазон по-русски. Месяцы целиком: «с марта по май 2026» (после «с» родительный падеж,
 * после «по» именительный, он же винительный). Даты: «с 1 марта по 15 мая 2026».
 */
function formatRange(fromIso: string, toIso: string): string {
  const from = parseIso(fromIso);
  const to = parseIso(toIso);
  const wholeMonths = from.day === 1 && to.day === daysInMonth(to.year, to.month - 1);
  if (wholeMonths) {
    if (from.year === to.year && from.month === to.month) return `${MONTH_NAMES[to.month - 1]} ${to.year}`;
    if (from.year === to.year) {
      return `с ${MONTHS_GENITIVE[from.month - 1]} по ${MONTH_NAMES[to.month - 1]} ${to.year}`;
    }
    return `с ${MONTHS_GENITIVE[from.month - 1]} ${from.year} по ${MONTH_NAMES[to.month - 1]} ${to.year}`;
  }
  const f = `${from.day} ${MONTHS_GENITIVE[from.month - 1]}`;
  const t = `${to.day} ${MONTHS_GENITIVE[to.month - 1]}`;
  return from.year === to.year ? `с ${f} по ${t} ${to.year}` : `с ${f} ${from.year} по ${t} ${to.year}`;
}

/**
 * «февраль 2026», «1 квартал 2026», «2026 год», «с начала года», «с марта по май 2026».
 * Для некорректного периода бросает PeriodError.
 */
export function formatPeriod(period: Period): string {
  switch (period.kind) {
    case 'month':
      checkYear(period.year);
      checkMonth(period.month);
      return `${MONTH_NAMES[period.month - 1]} ${period.year}`;
    case 'quarter':
      checkYear(period.year);
      checkQuarter(period.quarter);
      return `${period.quarter} квартал ${period.year}`;
    case 'year':
      checkYear(period.year);
      return `${period.year} год`;
    case 'ytd':
      return 'с начала года';
    case 'range':
      return formatRange(period.from, period.to);
  }
}

/** Для фразы «налог за …»: «за февраль 2026», «за 1 квартал 2026», «за 2026 год», «с начала года». */
export function formatPeriodFor(period: Period): string {
  const s = formatPeriod(period);
  return s.startsWith('с ') ? s : `за ${s}`;
}

/** Для фразы «в …»: «в феврале 2026», «в 1 квартале 2026», «в 2026 году». */
export function formatPeriodIn(period: Period): string {
  switch (period.kind) {
    case 'month':
      checkMonth(period.month);
      return `в ${MONTHS_PREPOSITIONAL[period.month - 1]} ${period.year}`;
    case 'quarter':
      return `в ${period.quarter} квартале ${period.year}`;
    case 'year':
      return `в ${period.year} году`;
    default:
      return formatPeriod(period);
  }
}

// ===== Разбор по-русски =====

/** Именительный, родительный, предложный падежи и сокращения. */
const MONTH_FORMS: string[][] = [
  ['январь', 'января', 'январе', 'янв'],
  ['февраль', 'февраля', 'феврале', 'фев', 'февр'],
  ['март', 'марта', 'марте', 'мар'],
  ['апрель', 'апреля', 'апреле', 'апр'],
  ['май', 'мая', 'мае'],
  ['июнь', 'июня', 'июне', 'июн'],
  ['июль', 'июля', 'июле', 'июл'],
  ['август', 'августа', 'августе', 'авг'],
  ['сентябрь', 'сентября', 'сентябре', 'сен', 'сент'],
  ['октябрь', 'октября', 'октябре', 'окт'],
  ['ноябрь', 'ноября', 'ноябре', 'ноя', 'нояб'],
  ['декабрь', 'декабря', 'декабре', 'дек'],
];

const MONTH_LOOKUP = new Map<string, number>();
MONTH_FORMS.forEach((forms, i) => forms.forEach((f) => MONTH_LOOKUP.set(f, i + 1)));

// \w в JavaScript не знает кириллицу, поэтому везде [а-я]
const MONTH_RE = [...MONTH_LOOKUP.keys()].sort((a, b) => b.length - a.length).join('|');
const YEAR_WORD = '(?:\\s*(?:года|году|год|г\\.?))?';
const MONTH_TOKEN = new RegExp(`^(${MONTH_RE})\\.?(?: (\\d{4}))?${YEAR_WORD}$`);
const DAY_TOKEN = new RegExp(`^(\\d{1,2}) (${MONTH_RE})\\.?(?: (\\d{4}))?${YEAR_WORD}$`);
const QUARTER_RE = new RegExp(
  `^(?:(\\d|iv|iii|ii|i|перв[а-я]+|втор[а-я]+|трет[а-я]+|четверт[а-я]+)(?:-?(?:й|ый|ой|ий|м|е|го))?\\s*(?:квартал[а-я]*|кв\\.?)|q([1-4]))(?: (\\d{4}))?${YEAR_WORD}$`,
);
const YEAR_RE = new RegExp(`^(\\d{4})${YEAR_WORD}$`);

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐-―−]/g, '-')
    .replace(/[,;!?"«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripPrefix(s: string): string {
  return s.replace(/^(?:по итогам|итого за|за|во|в|на)\s+/, '').trim();
}

function monthByName(token: string): number {
  return MONTH_LOOKUP.get(token)!;
}

function ordinalWord(word: string): number | null {
  if (/^\d$/.test(word)) return Number(word);
  if (ROMAN[word]) return ROMAN[word]!;
  if (word.startsWith('перв')) return 1;
  if (word.startsWith('втор')) return 2;
  if (word.startsWith('трет')) return 3;
  if (word.startsWith('четверт')) return 4;
  return null;
}

interface MonthTok {
  month: number;
  year: number | null;
}

/** «март», «март 2026», «марта 2026 года», «03.2026», «2026-03» */
function monthToken(tok: string): MonthTok | null {
  let m = MONTH_TOKEN.exec(tok);
  if (m) return { month: monthByName(m[1]!), year: m[2] ? Number(m[2]) : null };
  m = /^(\d{1,2})\.(\d{4})$/.exec(tok);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { month: Number(m[1]), year: Number(m[2]) };
  m = /^(\d{4})-(\d{2})$/.exec(tok);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { month: Number(m[2]), year: Number(m[1]) };
  return null;
}

interface DayTok {
  day: number;
  month: number;
  year: number | null;
}

/** «1 марта», «1 марта 2026», «01.03.2026», «2026-03-01» */
function dayToken(tok: string): DayTok | null {
  let m = DAY_TOKEN.exec(tok);
  if (m) return { day: Number(m[1]), month: monthByName(m[2]!), year: m[3] ? Number(m[3]) : null };
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(tok);
  if (m) return { day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tok);
  if (m) return { day: Number(m[3]), month: Number(m[2]), year: Number(m[1]) };
  return null;
}

function monthSpan(fromYear: number, fromMonth: number, toYear: number, toMonth: number): Period | null {
  if (ordinal(fromYear, fromMonth) > ordinal(toYear, toMonth)) return null;
  if (fromYear === toYear && fromMonth === toMonth) return { kind: 'month', year: toYear, month: toMonth };
  const lastDay = daysInMonth(toYear, toMonth - 1);
  return {
    kind: 'range',
    from: `${fromYear}-${pad(fromMonth)}-01`,
    to: `${toYear}-${pad(toMonth)}-${pad(lastDay)}`,
  };
}

function parseRaw(s: string, today: Moment): Period | null {
  const curYear = today.year;
  const curMonth = today.month + 1;

  if (/^(?:с начала (?:этого |текущего )?года(?: по (?:сегодня|сегодняшний день|текущую дату))?|ytd|нарастающим итогом)$/.test(s)) {
    return { kind: 'ytd' };
  }

  // этот, текущий, прошлый
  const rel = /^(этот|текущий|прошлый|предыдущий|эту|текущую|прошлую|предыдущую|этом|текущем|прошлом|предыдущем)\s+(месяц|месяце|квартал|квартале|год|году)$/.exec(s);
  if (rel) {
    const back = /^(прошл|предыдущ)/.test(rel[1]!) ? 1 : 0;
    const unit = rel[2]!;
    if (unit.startsWith('месяц')) {
      const o = ordinal(curYear, curMonth) - back;
      return { kind: 'month', year: Math.floor(o / 12), month: (o % 12) + 1 };
    }
    if (unit.startsWith('квартал')) {
      const q = Math.floor((curMonth - 1) / 3) + 1 - back;
      return q >= 1 ? { kind: 'quarter', year: curYear, quarter: q } : { kind: 'quarter', year: curYear - 1, quarter: 4 };
    }
    return { kind: 'year', year: curYear - back };
  }
  if (s === 'год') return { kind: 'year', year: curYear };

  // с X по Y
  let m = /^с (.+?) по (.+)$/.exec(s);
  if (m) {
    const a = m[1]!;
    const b = m[2]!;
    // «с 1 по 15 октября 2026»
    const bDay = dayToken(b);
    if (/^\d{1,2}$/.test(a) && bDay) {
      const year = bDay.year ?? curYear;
      const from = { year, month: bDay.month, day: Number(a) };
      const to = { year, month: bDay.month, day: bDay.day };
      return validYmd(from) && validYmd(to) && isoOf(from) <= isoOf(to)
        ? { kind: 'range', from: isoOf(from), to: isoOf(to) }
        : null;
    }
    const aDay = dayToken(a);
    if (aDay && bDay) {
      const toYear = bDay.year ?? curYear;
      let fromYear = aDay.year ?? toYear;
      const to = { year: toYear, month: bDay.month, day: bDay.day };
      // «с 20 декабря по 10 января 2027»: начало в предыдущем году
      if (aDay.year === null && isoOf({ year: fromYear, month: aDay.month, day: aDay.day }) > isoOf(to)) fromYear -= 1;
      const from = { year: fromYear, month: aDay.month, day: aDay.day };
      return validYmd(from) && validYmd(to) && isoOf(from) <= isoOf(to)
        ? { kind: 'range', from: isoOf(from), to: isoOf(to) }
        : null;
    }
    const aMon = monthToken(a);
    const bMon = monthToken(b);
    if (aMon && bMon) {
      const toYear = bMon.year ?? curYear;
      let fromYear = aMon.year ?? toYear;
      // «с ноября по февраль 2026»: начало в предыдущем году
      if (aMon.year === null && ordinal(fromYear, aMon.month) > ordinal(toYear, bMon.month)) fromYear -= 1;
      return monthSpan(fromYear, aMon.month, toYear, bMon.month);
    }
    return null;
  }

  // «январь-март 2026»
  m = new RegExp(`^(${MONTH_RE})\\.? ?- ?(${MONTH_RE})\\.?(?: (\\d{4}))?${YEAR_WORD}$`).exec(s);
  if (m) {
    const fm = monthByName(m[1]!);
    const tm = monthByName(m[2]!);
    const toYear = m[3] ? Number(m[3]) : curYear;
    return monthSpan(!m[3] && fm > tm ? toYear - 1 : toYear, fm, toYear, tm);
  }

  // «1 квартал 2026», «первый квартал», «I кв 2026», «q1 2026»
  m = QUARTER_RE.exec(s);
  if (m) {
    const q = ordinalWord(m[1] ?? m[2]!);
    return q ? { kind: 'quarter', year: m[3] ? Number(m[3]) : curYear, quarter: q } : null;
  }
  // «2026 1 квартал»
  m = /^(\d{4}) (\d)(?:-?(?:й|м))? ?(?:квартал[а-я]*|кв\.?)$/.exec(s);
  if (m) return { kind: 'quarter', year: Number(m[1]), quarter: Number(m[2]) };

  // «2026», «2026 год», «в 2026 году»
  m = YEAR_RE.exec(s);
  if (m) return { kind: 'year', year: Number(m[1]) };

  // «февраль 2026», «февраля», «02.2026», «2026-02»
  const mon = monthToken(s);
  if (mon) return { kind: 'month', year: mon.year ?? curYear, month: mon.month };

  return null;
}

/**
 * Разбор периода из русского текста. Возвращает null, если текст не похож на период или даты
 * несуществующие. Год, если не назван, берётся из `today`. Понимает:
 *  «февраль 2026», «за февраль», «в феврале 2026», «02.2026», «2026-02»
 *  «1 квартал 2026», «первый квартал», «I квартал 2026», «Q1 2026»
 *  «2026 год», «за 2026 год», «2026»
 *  «с начала года»
 *  «с марта по май 2026», «январь-март 2026», «с 1 марта по 15 мая 2026», «с 01.03.2026 по 15.05.2026»
 *  «этот месяц», «прошлый месяц», «этот квартал», «прошлый квартал», «этот год», «прошлый год»
 */
export function parsePeriod(text: string, today: Moment): Period | null {
  const s = stripPrefix(normalize(text));
  if (!s) return null;
  const p = parseRaw(s, today);
  if (!p) return null;
  try {
    formatPeriod(p);
    if (p.kind === 'range') {
      const from = parseIso(p.from);
      const to = parseIso(p.to);
      if (isoOf(from) > isoOf(to)) return null;
    }
  } catch {
    return null;
  }
  return p;
}
