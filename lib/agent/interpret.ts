import { resolvePeriod, type Moment, type Period } from '@/lib/calc';
import { mentionedEntities, mentionsGroup, unknownEntityNames } from './entities';
import { cyr } from './regex';
import { normalize } from './text';
import type {
  Ambiguity,
  EntityRef,
  Interpretation,
  NextYearReason,
  RateValue,
  Scenario,
  Slot,
  TaxKind,
  Unsupported,
} from './types';

/**
 * Понимание вопроса: юрлицо, налог, период, что именно просят. Слой устроен в два шага, чтобы
 * позже модель только извлекала поля, а решения принимал код:
 *
 *  1. extractFields: текст в «сырые» поля (RawFields). Это единственное, что делает провайдер:
 *     заглушка правилами (здесь), GigaChat позже моделью. Числа модель не считает.
 *  2. buildInterpretation: код сверяет поля с группой и данными, склеивает короткий ответ с
 *     прежним вопросом, подставляет допущения и находит неоднозначности и то, что не поддерживается.
 *
 * Числа считает calcTax. Здесь их нет вообще: только юрлица, налог, период, сценарий.
 */

export interface PeriodMention {
  period: Period;
  /** Допущение, если период назван не полностью: «квартал не назван, беру текущий» */
  note?: string;
}

/** Что извлекает провайдер. Всё необязательное: пустые значения означают «не названо». */
export interface RawFields {
  /** id юрлиц группы, названных по имени */
  entities: string[];
  /** «все», «группа», «в целом» */
  all: boolean;
  /** Названия, похожие на юрлицо, но не из группы */
  unknownEntities: string[];
  /** Названные налоги из поддерживаемых */
  taxes: TaxKind[];
  /** Названные налоги, которых агент не считает: «НДФЛ», «страховые взносы» */
  otherTaxes: string[];
  periods: PeriodMention[];
  scenario: Scenario | null;
  rate: RateValue | null;
  /** Просят юридическую оценку схемы */
  legal: boolean;
  /** Рост выручки в процентах из вопроса: «рост 10%» это 10, «падение на 5%» это -5, «без роста» это 0 */
  growth: number | null;
  /** Спрашивают про лимиты и пороги: им нужны утверждённые значения, прогноз их не заменяет */
  limits: boolean;
  /** Короткая реплика без своего вопроса: только юрлицо, налог или период («а за март?») */
  fragment: boolean;
}

export interface InterpretContext {
  entities: EntityRef[];
  today: Moment;
  /** Понимание предыдущего ответа или того ответа, к которому относится кнопка */
  previous: Interpretation | null;
  /** Чего агент ждал в ответ на уточняющий вопрос */
  awaiting: Slot[];
  /** Ответ пришёл с кнопки: всегда продолжает previous */
  refine: boolean;
  /** Месяцы, за которые в демо есть данные: первый и последний (месяц 1..12) */
  data: { from: { year: number; month: number }; to: { year: number; month: number } } | null;
  /** Следующий год и известен ли для него дефлятор */
  nextYear: { year: number; deflatorKnown: boolean } | null;
}

// ===== Названия месяцев =====

const MONTH_ROOTS: [string, number][] = [
  ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['июн', 6], ['июл', 7],
  ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12],
];
const MONTH_ENDINGS = '(?:ь|я|е|ю|ем|ом|у|а)?';
const MONTH_ADJ: [string, number][] = [
  ['январьск', 1], ['февральск', 2], ['мартовск', 3], ['апрельск', 4], ['майск', 5], ['июньск', 6],
  ['июльск', 7], ['августовск', 8], ['сентябрьск', 9], ['октябрьск', 10], ['ноябрьск', 11], ['декабрьск', 12],
];
const ADJ_ENDINGS = '(?:ий|ая|ое|ие|ого|ой|ую|ым|их|ими|ому|ом|ые)';
const MONTH_ABBR: Record<string, number> = {
  янв: 1, фев: 2, февр: 2, мар: 3, апр: 4, июн: 6, июл: 7, авг: 8, сен: 9, сент: 9, окт: 10, ноя: 11,
  нояб: 11, дек: 12,
};
const MAY = new Set(['май', 'мая', 'мае', 'маю', 'маем']);

/** Номер месяца по слову: «февраля», «феврале», «февральский», «февр.» */
export function monthOfWord(raw: string): number | null {
  const w = raw.replace(/\.$/, '');
  if (MAY.has(w)) return 5;
  if (w in MONTH_ABBR && raw.length >= 3) return MONTH_ABBR[w]!;
  for (const [root, n] of MONTH_ROOTS) {
    if (new RegExp(`^${root}${MONTH_ENDINGS}$`).test(w)) return n;
  }
  for (const [root, n] of MONTH_ADJ) {
    if (new RegExp(`^${root}${ADJ_ENDINGS}$`).test(w)) return n;
  }
  return null;
}

// ===== Токены =====

interface Tok {
  t: string;
  start: number;
  end: number;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[а-яa-z]+\.?|\d+(?:[.,]\d+)*|-/g;
  for (const m of text.matchAll(re)) out.push({ t: m[0], start: m.index!, end: m.index! + m[0].length });
  return out;
}

const isNum = (t: string | undefined): boolean => t !== undefined && /^\d+$/.test(t);
const isYear = (t: string | undefined): boolean => t !== undefined && /^(?:19|20|21)\d{2}$/.test(t);
const YEAR_WORDS = new Set(['года', 'году', 'год', 'г', 'г.']);

const ORDINAL_STEMS: [string, number][] = [['перв', 1], ['втор', 2], ['трет', 3], ['четверт', 4]];
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };
const QUARTER_SUFFIX = new Set(['й', 'ый', 'ой', 'ий', 'м', 'е', 'го', 'ом']);

function ordinalOf(word: string): number | null {
  if (word in ROMAN) return ROMAN[word]!;
  for (const [stem, n] of ORDINAL_STEMS) if (word.startsWith(stem) && word.length <= stem.length + 4) return n;
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Точка на оси времени из слов: месяц, возможно с днём и годом. */
interface Point {
  y: number | null;
  m: number;
  d: number | null;
  next: number;
}

function pointAt(toks: Tok[], i: number): Point | null {
  const a = toks[i]?.t;
  if (a === undefined) return null;

  // 01.03.2026
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(a);
  if (m) return { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]), next: i + 1 };
  // 03.2026
  m = /^(\d{1,2})\.(\d{4})$/.exec(a);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { d: null, m: Number(m[1]), y: Number(m[2]), next: i + 1 };
  // 2026-03-01 и 2026-03
  if (isYear(a) && toks[i + 1]?.t === '-' && /^\d{2}$/.test(toks[i + 2]?.t ?? '')) {
    const mm = Number(toks[i + 2]!.t);
    if (mm >= 1 && mm <= 12) {
      if (toks[i + 3]?.t === '-' && /^\d{2}$/.test(toks[i + 4]?.t ?? '')) {
        return { y: Number(a), m: mm, d: Number(toks[i + 4]!.t), next: i + 5 };
      }
      return { y: Number(a), m: mm, d: null, next: i + 3 };
    }
  }

  // [день] месяц [год]
  let j = i;
  let day: number | null = null;
  if (isNum(a) && Number(a) >= 1 && Number(a) <= 31 && monthOfWord(toks[i + 1]?.t ?? '') !== null) {
    day = Number(a);
    j = i + 1;
  }
  const month = monthOfWord(toks[j]?.t ?? '');
  if (month === null) return null;
  j += 1;
  let year: number | null = null;
  if (isYear(toks[j]?.t)) {
    year = Number(toks[j]!.t);
    j += 1;
    if (YEAR_WORDS.has(toks[j]?.t ?? '')) j += 1;
  }
  return { y: year, m: month, d: day, next: j };
}

function monthPeriod(y: number, m: number): Period {
  return { kind: 'month', year: y, month: m };
}

/** Диапазон из двух точек: месяцы целиком, если дней нет, иначе по датам. */
function spanOf(a: Point, b: Point, today: Moment): Period | null {
  const toYear = b.y ?? today.year;
  let fromYear = a.y ?? toYear;
  const key = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
  const toDay = b.d ?? lastDay(toYear, b.m);
  const fromDay = a.d ?? 1;
  // «с ноября по февраль»: начало в прошлом году, если год не назван
  if (a.y === null && key(fromYear, a.m, fromDay) > key(toYear, b.m, toDay)) fromYear -= 1;
  if (key(fromYear, a.m, fromDay) > key(toYear, b.m, toDay)) return null;
  if (a.d === null && b.d === null && fromYear === toYear && a.m === b.m) return monthPeriod(toYear, a.m);
  if (fromDay > lastDay(fromYear, a.m) || toDay > lastDay(toYear, b.m)) return null;
  return {
    kind: 'range',
    from: `${fromYear}-${pad(a.m)}-${pad(fromDay)}`,
    to: `${toYear}-${pad(b.m)}-${pad(toDay)}`,
  };
}

const WORD_COUNTS: Record<string, number> = {
  три: 3, шесть: 6, девять: 9, двенадцать: 12, один: 1, два: 2, четыре: 4, пять: 5, семь: 7, восемь: 8,
  десять: 10, одиннадцать: 11,
};

const REL_WORDS: Record<string, number> = {
  этот: 0, этом: 0, этого: 0, эту: 0, текущий: 0, текущем: 0, текущего: 0, текущую: 0, нынешний: 0,
  нынешнем: 0, прошлый: -1, прошлом: -1, прошлого: -1, прошлую: -1, предыдущий: -1, предыдущем: -1,
  предыдущего: -1, предыдущую: -1,
  следующий: 1, следующем: 1, следующего: 1, следующую: 1, будущий: 1, будущем: 1, будущего: 1, будущую: 1,
  грядущем: 1, грядущий: 1,
};
const UNIT_MONTH = new Set(['месяц', 'месяце', 'месяца']);
const UNIT_QUARTER = new Set(['квартал', 'квартале', 'квартала']);
const UNIT_YEAR = new Set(['год', 'году', 'года']);

/**
 * Периоды из текста. Токены, вошедшие в период, помечаются и больше не участвуют: «февраль 2026»
 * это один период, а не месяц плюс год.
 */
export function extractPeriods(text: string, today: Moment): PeriodMention[] {
  const t = normalize(text).replace(/[‐-―−]/g, '-');
  const toks = tokenize(t);
  const used = new Array<boolean>(toks.length).fill(false);
  const found: { at: number; mention: PeriodMention }[] = [];
  const mark = (from: number, to: number) => {
    for (let k = from; k < to; k++) used[k] = true;
  };
  const free = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (used[k]) return false;
    return true;
  };
  const add = (at: number, period: Period, note?: string) => found.push({ at, mention: { period, note } });
  const curMonth = today.month + 1;

  // 1. с начала года
  for (let i = 0; i < toks.length; i++) {
    const w = toks.slice(i, i + 4).map((x) => x.t);
    if (w[0] === 'с' && w[1] === 'начала') {
      let len = 2;
      if (w[2] === 'этого' || w[2] === 'текущего') len = 3;
      if (UNIT_YEAR.has(w[len] ?? '') && free(i, i + len + 1)) {
        add(i, { kind: 'ytd' });
        mark(i, i + len + 1);
      }
    } else if (w[0] === 'нарастающим' && w[1] === 'итогом' && free(i, i + 2)) {
      add(i, { kind: 'ytd' });
      mark(i, i + 2);
    } else if (w[0] === 'ytd' && free(i, i + 1)) {
      add(i, { kind: 'ytd' });
      mark(i, i + 1);
    }
  }

  // 2. с X по Y
  for (let i = 0; i < toks.length; i++) {
    if (!['с', 'со'].includes(toks[i]!.t) || used[i]) continue;
    // «с 1 по 15 октября»
    if (isNum(toks[i + 1]?.t) && toks[i + 2]?.t === 'по') {
      const day = Number(toks[i + 1]!.t);
      const b = pointAt(toks, i + 3);
      if (b && b.d !== null && day >= 1 && day <= 31 && free(i, b.next)) {
        const p = spanOf({ y: b.y, m: b.m, d: day, next: i + 2 }, b, today);
        if (p) {
          add(i, p);
          mark(i, b.next);
        }
      }
      continue;
    }
    const a = pointAt(toks, i + 1);
    if (!a || toks[a.next]?.t !== 'по') continue;
    const b = pointAt(toks, a.next + 1);
    if (!b || !free(i, b.next)) continue;
    const p = spanOf(a, b, today);
    if (p) {
      add(i, p);
      mark(i, b.next);
    }
  }

  // 3. январь-март [год]
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i + 1]!.t !== '-' || !free(i, i + 3)) continue;
    const a = monthOfWord(toks[i]!.t);
    const b = monthOfWord(toks[i + 2]!.t);
    if (a === null || b === null) continue;
    let end = i + 3;
    let year: number | null = null;
    if (isYear(toks[end]?.t)) {
      year = Number(toks[end]!.t);
      end += 1;
      if (YEAR_WORDS.has(toks[end]?.t ?? '')) end += 1;
    }
    const p = spanOf({ y: null, m: a, d: null, next: i }, { y: year, m: b, d: null, next: end }, today);
    if (p) {
      add(i, p);
      mark(i, end);
    }
  }

  // 4. квартал: «2 квартал», «за 3 квартал 2026», «II кв.», «первый квартал», «q1»
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!.t;
    if (/^квартал/.test(w) || w === 'кв' || w === 'кв.') {
      let j = i - 1;
      if (j >= 0 && QUARTER_SUFFIX.has(toks[j]!.t)) j -= 1;
      if (j >= 0 && toks[j]!.t === '-') j -= 1;
      const numTok = toks[j]?.t;
      let q: number | null = null;
      if (numTok !== undefined && /^[1-4]$/.test(numTok)) q = Number(numTok);
      else if (numTok !== undefined) q = ordinalOf(numTok);
      let end = i + 1;
      let year: number | null = null;
      if (isYear(toks[end]?.t)) {
        year = Number(toks[end]!.t);
        end += 1;
        if (YEAR_WORDS.has(toks[end]?.t ?? '')) end += 1;
      }
      if (q !== null && free(j, end)) {
        add(j, { kind: 'quarter', year: year ?? today.year, quarter: q });
        mark(j, end);
      }
    } else if (w === 'q' && /^[1-4]$/.test(toks[i + 1]?.t ?? '') && free(i, i + 2)) {
      let end = i + 2;
      let year: number | null = null;
      if (isYear(toks[end]?.t)) {
        year = Number(toks[end]!.t);
        end += 1;
      }
      add(i, { kind: 'quarter', year: year ?? today.year, quarter: Number(toks[i + 1]!.t) });
      mark(i, end);
    }
  }

  // 5. полугодие и «9 месяцев»
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!.t;
    if (/^полугоди/.test(w) && free(i, i + 1)) {
      const prev = toks[i - 1]?.t;
      let half: number | null = null;
      if (prev !== undefined) half = prev === '1' ? 1 : prev === '2' ? 2 : ordinalOf(prev);
      const year = isYear(toks[i + 1]?.t) ? Number(toks[i + 1]!.t) : today.year;
      const at = half !== null && free(i - 1, i + 1) ? i - 1 : i;
      const h = half === 2 ? 2 : 1;
      add(
        at,
        { kind: 'range', from: h === 1 ? `${year}-01-01` : `${year}-07-01`, to: h === 1 ? `${year}-06-30` : `${year}-12-31` },
        half === null ? 'полугодие не уточнено, беру первое' : undefined,
      );
      mark(at, i + 1);
    } else if (/^месяц/.test(w) && i > 0 && free(i - 1, i + 1) && /^месяц(?:ев|а)$/.test(w)) {
      const prev = toks[i - 1]!.t;
      const n = isNum(prev) ? Number(prev) : WORD_COUNTS[prev];
      if (n !== undefined && n >= 2 && n <= 12) {
        const year = today.year;
        add(i - 1, { kind: 'range', from: `${year}-01-01`, to: `${year}-${pad(n)}-${lastDay(year, n)}` });
        mark(i - 1, i + 1);
      }
    }
  }

  // 6. этот, прошлый + месяц, квартал, год
  for (let i = 0; i + 1 < toks.length; i++) {
    const shift = REL_WORDS[toks[i]!.t];
    if (shift === undefined || !free(i, i + 2)) continue;
    const unit = toks[i + 1]!.t;
    if (UNIT_MONTH.has(unit)) {
      const o = today.year * 12 + (curMonth - 1) + shift;
      add(i, monthPeriod(Math.floor(o / 12), (o % 12) + 1));
      mark(i, i + 2);
    } else if (UNIT_QUARTER.has(unit)) {
      const q = Math.floor((curMonth - 1) / 3) + 1 + shift;
      add(
        i,
        q > 4
          ? { kind: 'quarter', year: today.year + 1, quarter: q - 4 }
          : q >= 1
            ? { kind: 'quarter', year: today.year, quarter: q }
            : { kind: 'quarter', year: today.year - 1, quarter: 4 },
      );
      mark(i, i + 2);
    } else if (UNIT_YEAR.has(unit)) {
      add(i, { kind: 'year', year: today.year + shift });
      mark(i, i + 2);
    }
  }

  // 7. месяц [год] и дата «28 октября»
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    const p = pointAt(toks, i);
    if (!p || !free(i, p.next)) continue;
    add(i, monthPeriod(p.y ?? today.year, p.m));
    mark(i, p.next);
  }

  // 8. год: «2026 год», «за 2025», «в 2027 году»
  for (let i = 0; i < toks.length; i++) {
    if (used[i] || !isYear(toks[i]!.t)) continue;
    const next = toks[i + 1]?.t ?? '';
    // «5000 машин», «2027 млн»: после числа идёт единица измерения
    if (/^(?:млн|руб|р|рублей|машин|шт|тыс|₽)/.test(next)) continue;
    add(i, { kind: 'year', year: Number(toks[i]!.t) });
    mark(i, i + (YEAR_WORDS.has(next) ? 2 : 1));
  }

  // 9. слова без числа: «за квартал», «за месяц», «за год», «годовой»
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    const w = toks[i]!.t;
    if (/^квартал(?:е|а|ьн)/.test(w) || w === 'квартал') {
      add(i, { kind: 'quarter', year: today.year, quarter: Math.floor((curMonth - 1) / 3) + 1 }, 'квартал не назван, беру текущий');
      used[i] = true;
    } else if (/^месяц(?:е|а)?$/.test(w) || /^месячн/.test(w)) {
      add(i, monthPeriod(today.year, curMonth), 'месяц не назван, беру текущий');
      used[i] = true;
    } else if (UNIT_YEAR.has(w) || /^годов/.test(w)) {
      // «за год 2025»: слово «год» рядом с названным годом, отдельного периода нет
      if (used[i - 1] || used[i + 1]) {
        used[i] = true;
        continue;
      }
      // «за год» без номера это текущий год: допущения нет, год показан в карточке
      add(i, { kind: 'year', year: today.year });
      used[i] = true;
    }
  }

  found.sort((a, b) => a.at - b.at);
  return found.map((f) => f.mention);
}

/** Несколько названных периодов в один: подряд идущие месяцы и «год + месяц». */
export function mergeMentions(input: PeriodMention[]): PeriodMention[] {
  const seen = new Set<string>();
  const list = input.filter((m) => {
    const key = JSON.stringify(m.period);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (list.length < 2) return list;
  const out = list.slice();

  // «за 2025 год в феврале»: год без своего месяца присоединяется к месяцу или кварталу без года
  const years = out.filter((m) => m.period.kind === 'year');
  const small = out.filter((m) => m.period.kind === 'month' || m.period.kind === 'quarter');
  if (years.length === 1 && small.length === 1 && out.length === 2) {
    const y = (years[0]!.period as { year: number }).year;
    const p = small[0]!.period;
    if (p.kind === 'month') return [{ period: { kind: 'month', year: y, month: p.month } }];
    if (p.kind === 'quarter') return [{ period: { kind: 'quarter', year: y, quarter: p.quarter } }];
  }

  // подряд идущие месяцы одного списка склеиваются в диапазон
  if (out.every((m) => m.period.kind === 'month')) {
    const idx = out
      .map((m) => (m.period as { year: number; month: number }))
      .map((p) => p.year * 12 + (p.month - 1))
      .sort((a, b) => a - b);
    if (idx.every((v, k) => k === 0 || v === idx[k - 1]! + 1)) {
      const a = idx[0]!;
      const b = idx[idx.length - 1]!;
      const ya = Math.floor(a / 12);
      const ma = (a % 12) + 1;
      const yb = Math.floor(b / 12);
      const mb = (b % 12) + 1;
      return [
        { period: { kind: 'range', from: `${ya}-${pad(ma)}-01`, to: `${yb}-${pad(mb)}-${pad(lastDay(yb, mb))}` } },
      ];
    }
  }
  return out;
}

// ===== Налоги, ставка, сценарий =====

const OTHER_TAXES: [RegExp, string][] = [
  [cyr('ндфл|подоходн\\w+|налог\\w* на доход\\w* физ\\w*'), 'НДФЛ'],
  [cyr('страхов\\w+ взнос\\w*|пфр|фсс|взнос\\w*'), 'страховые взносы'],
  [cyr('енвд|вмененн\\w+'), 'ЕНВД'],
  [cyr('\\bпсн\\b|патент\\w*'), 'патент'],
  [cyr('есхн|сельхозналог\\w*'), 'ЕСХН'],
  [cyr('налог\\w* на имуществ\\w*'), 'налог на имущество'],
  [cyr('транспортн\\w+ налог\\w*'), 'транспортный налог'],
  [cyr('земельн\\w+ налог\\w*'), 'земельный налог'],
  [cyr('акциз\\w*'), 'акцизы'],
  [cyr('налог\\w* на профессиональн\\w+ доход\\w*|\\bнпд\\b|самозанят\\w*'), 'налог для самозанятых'],
  [cyr('таможенн\\w+ (?:пошлин|сбор)\\w*|пошлин\\w*'), 'пошлины'],
];

const TAX_PATTERNS: [RegExp, TaxKind][] = [
  [cyr('\\bндс\\b|добавленн\\w+ стоимост\\w*'), 'vat'],
  [cyr('\\bусн\\b|упрощенк\\w*|упрощенн\\w+ систем\\w*|единый налог|налог\\w* (?:на|с) доход\\w*'), 'usn'],
  [cyr('налог\\w* на прибыл\\w*|прибыл\\w*'), 'profit'],
];

const RATE_NUM = cyr('(?:ставк\\w*\\s*(?:на|в|по)?\\s*)(5|7|22)\\b|(?<![0-9])(5|7|22)\\s*(?:%|процент\\w*)');

const CARS = cyr(
  'куп(?:им|ит|ить|ка|или|лю|ишь|ите|ят|ленн\\w*)|приобре\\w+|покуп|новых? (?:машин|авто)|добав\\w* (?:машин|авто)|лизинг|(?:машин|авто|автомобил)\\w* по \\d|\\d+ (?:машин|авто|автомобил)',
);
const THRESHOLD = cyr('порог\\w*|предупрежд\\w*|20 млн|освобожд\\w*|риск\\w*|пересеч\\w*');
const FRAGMENTATION = cyr('дроблен\\w*|объедин\\w*|едины\\w+ бизнес\\w*|признак\\w*');
const DEDUCT = cyr('вычет\\w*|входящ\\w*|входной|входного|закуп\\w*');
const PAYMENT = cyr(
  'ближайш\\w+ (?:платеж|срок)\\w*|когда (?:платить|платеж|заплатить|надо платить|нужно платить|платим)|срок\\w* (?:уплат|платеж)\\w*|до какого числа',
);
const COMPARE = cyr(
  'выгодн\\w*|дешевле|какую ставку|выбрат\\w* ставк\\w*|переплат\\w*|эконом\\w*|что лучше|ставк\\w* лучше|лучш\\w+ ставк\\w*',
);
const COMPARE_WORD = cyr('сравн\\w*');
const RATE_WORD = cyr('ставк\\w*');
const FORECAST = cyr('прогноз\\w*|до конца года|на конец года|ожида\\w+');
const HOW_MUCH = cyr('сколько');

/** Рост выручки: «рост 10%», «рост выручки +20%», «увеличим на 15 процентов». */
const GROWTH_UP = cyr(
  '(?:рост\\w*|увелич\\w*|вырастет\\w*|вырастем)\\s*(?:выручк\\w*\\s*)?(?:на\\s*)?\\+?\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:%|процент\\w*)?',
);
/** Спад выручки: «падение на 10%», «снизится на 5 процентов». */
const GROWTH_DOWN = cyr(
  '(?:снижени\\w*|падени\\w*|спад\\w*|уменьш\\w*|снизит\\w*|упад\\w*)\\s*(?:выручк\\w*\\s*)?(?:на\\s*)?[-−]?\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:%|процент\\w*)?',
);
/** Число со знаком и процентом без слова: «а если +15%?» */
const GROWTH_SIGNED = /(?<![0-9a-zа-я])([+−-])\s*(\d+(?:[.,]\d+)?)\s*%/;
const GROWTH_NONE = cyr('без роста|рост\\w* не буд\\w+|нулев\\w+ рост\\w*');
/** Вопрос о лимитах и порогах: прогноз на следующий год без утверждённого дефлятора их не называет. */
const LIMITS = cyr('лимит\\w*|дефлятор\\w*|предел\\w*|верхн\\w+ границ\\w*|границ\\w+ ставк\\w*');

const LEGAL = cyr(
  'законн\\w*|легальн\\w*|незаконн\\w*|правомерн\\w*|можно ли так|накажут|оштрафуют|уголовн\\w*|признает ли (?:налоговая|фнс)|юридическ\\w+ (?:оценк|заключени|консультац)\\w*|оцени\\w* схем\\w*|судебн\\w*|не посадят',
);

const FILLER = new Set([
  'а', 'и', 'же', 'ли', 'ну', 'так', 'по', 'за', 'в', 'во', 'на', 'у', 'для', 'с', 'со', 'к', 'до', 'от',
  'из', 'о', 'об', 'мне', 'нам', 'теперь', 'тогда', 'давай', 'давайте', 'пожалуйста', 'еще', 'также',
  'тоже', 'то', 'есть', 'покажи', 'покажите', 'посмотри', 'юрлицу', 'юрлицам', 'юрлицо', 'юрлица',
  'компании', 'компания', 'фирме', 'фирма', 'группе', 'группа', 'группу', 'всем', 'все', 'всех',
  'только', 'ещё', 'уже', 'этот', 'эту', 'это', 'не', 'что', 'как', 'ок', 'да', 'нет', 'если', 'пусть',
]);

/** Ставка из текста: только 5, 7 или 22. «УСН 6%» ставкой НДС не считается. */
function rateOf(t: string): RateValue | null {
  const m = RATE_NUM.exec(t);
  if (!m) return null;
  const v = Number(m[1] ?? m[2]);
  return v === 5 || v === 7 || v === 22 ? v : null;
}

function blank(t: string, re: RegExp): string {
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  return t.replace(g, (m) => ' '.repeat(m.length));
}

/**
 * Правила заглушки: текст в поля. Это и есть то, что позже заменит модель; вся логика
 * выбора (что считать, что спросить) остаётся в buildInterpretation.
 */
export function extractFields(text: string, ctx: Pick<InterpretContext, 'entities' | 'today'>): RawFields {
  const normalized = normalize(text).replace(/[‐-―−]/g, '-');

  // рост выручки вырезается первым: «рост 5%» не ставка НДС, «+10%» не часть периода
  let t = normalized;
  let growth: number | null = null;
  const num = (s: string) => Number(s.replace(',', '.'));
  const up = GROWTH_UP.exec(t);
  const down = GROWTH_DOWN.exec(t);
  const signed = GROWTH_SIGNED.exec(t);
  if (GROWTH_NONE.test(t)) {
    growth = 0;
    t = blank(t, GROWTH_NONE);
  } else if (up) {
    growth = num(up[1]!);
    t = blank(t, GROWTH_UP);
  } else if (down) {
    growth = -num(down[1]!);
    t = blank(t, GROWTH_DOWN);
  } else if (signed) {
    growth = (signed[1] === '+' ? 1 : -1) * num(signed[2]!);
    t = blank(t, GROWTH_SIGNED);
  }

  // налоги вне списка вырезаются раньше, чтобы «налог на доходы физлиц» не стал УСН
  let rest = t;
  const otherTaxes: string[] = [];
  for (const [re, name] of OTHER_TAXES) {
    if (re.test(rest)) {
      otherTaxes.push(name);
      rest = blank(rest, re);
    }
  }

  const taxes: TaxKind[] = [];
  for (const [re, kind] of TAX_PATTERNS) {
    if (re.test(rest)) {
      taxes.push(kind);
      rest = blank(rest, re);
    }
  }

  const named = mentionedEntities(text, ctx.entities);
  const all = mentionsGroup(text);
  const unknownEntities = unknownEntityNames(text, ctx.entities);
  const rate = rateOf(t);
  const mentions = mergeMentions(extractPeriods(text, ctx.today));

  const legal = LEGAL.test(t);
  const limits = LIMITS.test(t);

  // сценарий: порядок как у прежних разделов агента
  let scenario: Scenario | null = null;
  if (CARS.test(rest)) scenario = 'cars';
  else if (THRESHOLD.test(rest)) scenario = 'threshold';
  else if (FRAGMENTATION.test(rest)) scenario = 'fragmentation';
  else if (DEDUCT.test(rest)) scenario = 'deduct';
  else if (PAYMENT.test(rest)) scenario = 'payment';
  else if (COMPARE.test(rest) || (COMPARE_WORD.test(rest) && (RATE_WORD.test(rest) || rate !== null))) {
    scenario = 'compare_rates';
  } else if (RATE_WORD.test(rest) || rate !== null) {
    // «сколько НДС за февраль по ставке 22%»: ставка уточняет расчёт, а не меняет вопрос
    scenario = mentions.length > 0 || HOW_MUCH.test(rest) ? null : 'rate';
  } else if (FORECAST.test(rest)) scenario = 'forecast';

  // короткая реплика: после вычёркивания юрлиц, налогов и периодов не осталось слов вопроса
  let core = rest;
  for (const e of named) for (const a of e.aliases) {
    const re = cyr(`${a.replace(/[аяеиоуыэюь]$/, '')}[а-я]{0,3}`);
    core = blank(core, re);
  }
  core = blank(core, GROUP_WORDS);
  const words = core.match(/[а-яa-z]+/g) ?? [];
  const periodWords = new Set(
    tokenize(t)
      .map((x) => x.t)
      .filter((w) => monthOfWord(w) !== null || /^(?:квартал|кв|год|года|году|месяц|месяца|начала|итогом|прошлый|прошлом|текущий|этот|этом|прошлого|текущего|нарастающим|полугодие|полугодия|месяцев|месяца|q|i|ii|iii|iv|перв\w*|втор\w*|трет\w*|четверт\w*|квартале|месяце)/.test(w)),
  );
  const content = words.filter((w) => !FILLER.has(w) && !periodWords.has(w) && !/^\d+$/.test(w) && w.length > 1);
  const fragment = content.length === 0 && scenario === null;

  return {
    entities: named.map((e) => e.id),
    all,
    unknownEntities,
    taxes,
    otherTaxes,
    periods: mentions,
    scenario,
    rate,
    legal,
    growth,
    limits,
    fragment,
  };
}

const GROUP_WORDS = cyr('(?:^|[^а-яa-z0-9])(?:все|всех|всем|всеми|весь|всю|всей)(?![а-яa-z0-9])|групп\\w*|в целом|целиком|суммарн\\w*|совокупн\\w*');

// ===== Сборка понимания =====

/** Проверка полей провайдера: модель может прислать что угодно, в понимание попадает только допустимое. */
export function sanitizeFields(raw: Partial<RawFields>, ctx: Pick<InterpretContext, 'entities' | 'today'>): RawFields {
  const ids = new Set(ctx.entities.map((e) => e.id));
  const taxes = (raw.taxes ?? []).filter((x): x is TaxKind => x === 'vat' || x === 'usn' || x === 'profit');
  const scenarios: Scenario[] = [
    'rate', 'compare_rates', 'forecast', 'threshold', 'payment', 'deduct', 'fragmentation', 'cars',
  ];
  const periods: PeriodMention[] = [];
  for (const m of raw.periods ?? []) {
    try {
      resolvePeriod(m.period, ctx.today);
      periods.push({ period: m.period, note: typeof m.note === 'string' ? m.note : undefined });
    } catch {
      // период не разобрался: считаем, что он не назван
    }
  }
  const rate = raw.rate === 5 || raw.rate === 7 || raw.rate === 22 ? raw.rate : null;
  const growth =
    typeof raw.growth === 'number' && Number.isFinite(raw.growth) && raw.growth >= -90 && raw.growth <= 500
      ? raw.growth
      : null;
  return {
    entities: [...new Set((raw.entities ?? []).filter((id) => ids.has(id)))],
    all: Boolean(raw.all),
    unknownEntities: (raw.unknownEntities ?? []).filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3),
    taxes: [...new Set(taxes)],
    otherTaxes: (raw.otherTaxes ?? []).filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3),
    periods: periods.slice(0, 4),
    scenario: scenarios.includes(raw.scenario as Scenario) ? (raw.scenario as Scenario) : null,
    rate,
    legal: Boolean(raw.legal),
    growth,
    limits: Boolean(raw.limits),
    fragment: Boolean(raw.fragment),
  };
}

const AMOUNT_LIKE: (Scenario | null)[] = [null, 'forecast', 'payment'];

/** Прежние разделы, которые отвечают без налога и периода. */
export function isLegacyScenario(s: Scenario | null): boolean {
  return s !== null && !AMOUNT_LIKE.includes(s);
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** Период выходит за данные демо или в следующий год? */
function unsupportedPeriod(p: Period, ctx: InterpretContext): Unsupported | null {
  let months;
  try {
    months = resolvePeriod(p, ctx.today).months;
  } catch {
    return null;
  }
  if (ctx.nextYear && months.some((m) => m.year === ctx.nextYear!.year)) {
    return { kind: 'next_year', year: ctx.nextYear.year, period: p, reason: 'limits' };
  }
  if (ctx.data) {
    const lo = monthIndex(ctx.data.from.year, ctx.data.from.month);
    const hi = monthIndex(ctx.data.to.year, ctx.data.to.month);
    if (months.some((m) => monthIndex(m.year, m.month) < lo || monthIndex(m.year, m.month) > hi)) {
      return { kind: 'period_out_of_data', period: p };
    }
  }
  return null;
}

/**
 * Поля в понимание: склейка с прежним вопросом, допущения, неоднозначности, неподдерживаемое.
 * Правила склейки:
 *  - кнопка (refine) всегда продолжает прежний вопрос;
 *  - короткая реплика («февраль», «по Бете», «УСН») продолжает прежний вопрос, если он есть;
 *  - реплика со своим сценарием («что с порогами?») это новый вопрос.
 */
export function buildInterpretation(rawIn: RawFields, ctx: InterpretContext): Interpretation {
  const raw = rawIn;
  const prev = ctx.previous;
  const hasSlot =
    raw.all ||
    raw.entities.length > 0 ||
    raw.taxes.length > 0 ||
    raw.periods.length > 0 ||
    raw.rate !== null ||
    raw.growth !== null;
  const fillsAwaited =
    (ctx.awaiting.includes('tax') && raw.taxes.length > 0) ||
    (ctx.awaiting.includes('period') && raw.periods.length > 0) ||
    (ctx.awaiting.includes('entity') && (raw.all || raw.entities.length > 0));
  const ownTopic = raw.scenario !== null && raw.scenario !== prev?.scenario;
  // «налог на прибыль за год»: налог и период названы, это целый вопрос, а не уточнение
  const complete = raw.taxes.length === 1 && raw.periods.length > 0;

  let merge = false;
  if (prev) {
    if (ctx.refine) merge = hasSlot;
    else if (fillsAwaited && !ownTopic) merge = true;
    else if (raw.fragment && hasSlot && !complete) merge = true;
    // «а если рост 10%?» после прогноза: тот же вопрос с другим ростом
    else if (raw.growth !== null && prev.forecast) merge = true;
  }

  // слоты из этого сообщения, затем недостающее из прежнего
  let entityMode: Interpretation['entityMode'] = 'none';
  let entities: string[] = [];
  if (raw.entities.length > 0) {
    entityMode = 'named';
    entities = raw.entities;
  } else if (raw.all) {
    entityMode = 'group';
  } else if (merge && prev) {
    entityMode = prev.entityMode;
    entities = prev.entities;
  }

  const taxesNamed = raw.taxes;
  let tax: TaxKind | null = taxesNamed.length === 1 ? taxesNamed[0]! : null;
  let periodMentions = raw.periods;
  if (merge && prev) {
    if (taxesNamed.length === 0) tax = prev.tax;
    if (periodMentions.length === 0 && prev.period) periodMentions = [{ period: prev.period }];
  }

  let scenario = raw.scenario;
  let rate = raw.rate;
  if (merge && prev) {
    if (scenario === null) {
      // реплика с налогом или периодом переводит прежний «сравни ставки» в обычный расчёт суммы
      const changesAmount = raw.taxes.length > 0 || raw.periods.length > 0;
      scenario = changesAmount && isLegacyScenario(prev.scenario) ? null : prev.scenario;
    }
    if (rate === null) rate = prev.rate;
  }

  const ambiguities: Ambiguity[] = [];
  const amountLike = AMOUNT_LIKE.includes(scenario);

  // период
  let period: Period | null = null;
  if (periodMentions.length === 1) {
    period = periodMentions[0]!.period;
    const note = periodMentions[0]!.note;
    if (note) ambiguities.push({ slot: 'period', kind: 'assumed', note });
  } else if (periodMentions.length > 1) {
    ambiguities.push({ slot: 'period', kind: 'multiple', periods: periodMentions.map((m) => m.period) });
  }

  // налог
  if (taxesNamed.length > 1) {
    ambiguities.push({ slot: 'tax', kind: 'multiple', taxes: taxesNamed });
  }

  if (amountLike) {
    if (period === null && periodMentions.length === 0 && scenario !== 'payment') {
      ambiguities.push({ slot: 'period', kind: 'missing' });
    }
    if (tax === null && taxesNamed.length <= 1) {
      if (period !== null && scenario !== 'payment') {
        // налог не назван, а период назван: считаем НДС и говорим об этом
        tax = 'vat';
        ambiguities.push({ slot: 'tax', kind: 'assumed', note: 'налог не назван, считаю НДС' });
      } else {
        ambiguities.push({ slot: 'tax', kind: 'missing' });
      }
    }
  }

  if (entityMode === 'none') {
    ambiguities.push({ slot: 'entity', kind: 'assumed', note: 'юрлицо не названо, считаю по всей группе' });
  }

  // прогноз следующего года: период целиком в следующем году, налог НДС или не назван, вопрос не
  // о лимитах. Считает calcTax по сценарию: выручка как в этом году с ростом, лимиты как в этом году
  const nextYear = ctx.nextYear?.year ?? null;
  const monthsOf = (p: Period) => {
    try {
      return resolvePeriod(p, ctx.today).months;
    } catch {
      return [];
    }
  };
  let forecast: Interpretation['forecast'] = null;
  if (nextYear !== null && period !== null && periodMentions.length === 1) {
    const months = monthsOf(period);
    const whole = months.length > 0 && months.every((m) => m.year === nextYear);
    const topic = scenario === null || scenario === 'compare_rates' || scenario === 'rate' || scenario === 'forecast';
    const vatOnly = taxesNamed.length <= 1 && (tax === null || tax === 'vat');
    if (
      whole &&
      topic &&
      vatOnly &&
      !raw.limits &&
      !raw.legal &&
      raw.otherTaxes.length === 0 &&
      raw.unknownEntities.length === 0
    ) {
      const carried = merge && prev?.forecast ? prev.forecast.growth : 0;
      forecast = { year: nextYear, growth: raw.growth ?? carried };
    }
  }

  // неподдерживаемое: оценка схемы, другой налог, чужое юрлицо, период вне данных
  let unsupported: Unsupported | null = null;
  if (raw.legal) unsupported = { kind: 'legal_assessment' };
  else if (raw.otherTaxes.length > 0) unsupported = { kind: 'other_tax', name: raw.otherTaxes[0]! };
  else if (raw.unknownEntities.length > 0) unsupported = { kind: 'unknown_entity', name: raw.unknownEntities[0]! };
  else {
    for (const m of periodMentions) {
      if (forecast) break;
      const found = unsupportedPeriod(m.period, ctx);
      if (!found) continue;
      if (found.kind === 'next_year') {
        // почему следующий год не посчитать: смешанный период, другой налог, нужны лимиты, иной вопрос
        const whole = monthsOf(m.period).every((x) => x.year === found.year);
        const amountTopic =
          scenario === null || scenario === 'compare_rates' || scenario === 'rate' || scenario === 'forecast';
        const reason: NextYearReason = !whole
          ? 'mixed'
          : tax === 'usn' || tax === 'profit' || taxesNamed.length > 1
            ? 'tax'
            : raw.limits || scenario === 'threshold' || amountTopic
              ? 'limits'
              : 'other';
        unsupported = { ...found, reason };
      } else {
        unsupported = found;
      }
      break;
    }
  }

  let confidence = 0;
  if (entityMode !== 'none') confidence += 0.2;
  if (tax !== null && !ambiguities.some((a) => a.slot === 'tax')) confidence += 0.3;
  else if (tax !== null) confidence += 0.1;
  if (period !== null && !ambiguities.some((a) => a.slot === 'period')) confidence += 0.3;
  else if (period !== null) confidence += 0.15;
  if (scenario !== null) confidence += 0.2;
  if (unsupported) confidence = Math.min(confidence, 0.3);

  return {
    entities,
    entityMode,
    tax,
    period,
    scenario,
    rate,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    ambiguities,
    unsupported,
    forecast,
  };
}

/** Текст в понимание правилами заглушки. Синхронная форма для тестов и заглушки. */
export function interpret(text: string, ctx: InterpretContext): Interpretation {
  return buildInterpretation(extractFields(text, ctx), ctx);
}

/** Слоты, без которых ответ не построить. */
export function blockingSlots(i: Interpretation): Slot[] {
  return i.ambiguities.filter((a) => a.kind !== 'assumed').map((a) => a.slot);
}

/** Какой ответ строить по понятому вопросу. */
export type AnswerKind = 'amount' | 'rates' | 'warnings' | 'fragmentation' | 'deduct' | 'cars' | 'payment';

export function answerKind(i: Interpretation): AnswerKind {
  switch (i.scenario) {
    case 'cars':
      return 'cars';
    case 'threshold':
      return 'warnings';
    case 'fragmentation':
      return 'fragmentation';
    case 'deduct':
      return 'deduct';
    case 'payment':
      return 'payment';
    case 'compare_rates':
    case 'rate':
      return 'rates';
    default:
      return 'amount';
  }
}
