import { D, dec, round2, type Dec } from './decimal';
import { dateRuYear, rub, rub2 } from './format';
import type { RuleRow } from './rules';
import { momentFromEpoch } from './time';

/**
 * Происхождение цифр. Каждое число расчёта получено шагом формулы: у шага есть строка для людей
 * («выручка 1 988 000 ₽ × 5 / 105 = 94 666,67 ₽») и выражение, по которому результат можно
 * пересчитать независимо. Выражение состоит из чисел, ссылок на предыдущие шаги (s3),
 * знаков + - * / скобок и функций max, min, round2.
 */

/** Источник данных: строка data_sources. */
export interface SourceRef {
  id: string;
  kind: string;
  title: string;
  isDemo: boolean;
  /** Момент загрузки, ISO 8601 (UTC) */
  loadedAt: string;
}

/** Правило справочника, которое применено в расчёте. */
export interface RuleRef {
  key: string;
  /** Значение из справочника; для формулы с неутверждённым числом null */
  value: string | null;
  formula: string | null;
  unit: string;
  /** Статья НК РФ */
  norm: string | null;
  /** Действует с */
  validFrom: string;
  validTo: string | null;
  sourceUrl: string | null;
  note: string | null;
}

export interface FormulaStep {
  /** s1, s2, ... в порядке вычисления */
  id: string;
  /** Что считается: «ООО «Альфа», март 2026» */
  label: string;
  /** Формула с подставленными числами */
  text: string;
  /** Выражение для проверки: числа, ссылки на предыдущие шаги, + - * / ( ), max, min, round2 */
  expression: string;
  result: Dec;
  entityId: string | null;
  /** 2026-03; null для итогов по периоду и по юрлицу */
  month: string | null;
}

export function sourceRef(row: {
  id: string;
  kind: string;
  title: string;
  isDemo: boolean;
  loadedAt: Date | string;
}): SourceRef {
  const at = row.loadedAt instanceof Date ? row.loadedAt : new Date(row.loadedAt);
  return { id: row.id, kind: row.kind, title: row.title, isDemo: row.isDemo, loadedAt: at.toISOString() };
}

export function ruleRef(row: RuleRow): RuleRef {
  return {
    key: row.key,
    value: row.value,
    formula: row.formula,
    unit: row.unit,
    norm: row.norm ?? null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    sourceUrl: row.sourceUrl ?? null,
    note: row.note ?? null,
  };
}

/** «10 октября 2026, 18:00» в часовом поясе приложения. */
export function formatLoadedAt(loadedAtIso: string, tz: string): string {
  const m = momentFromEpoch(new Date(loadedAtIso).getTime(), tz);
  const hh = Math.floor(m.secondsOfDay / 3600);
  const mm = Math.floor((m.secondsOfDay % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dateRuYear({ year: m.year, month: m.month, day: m.day })}, ${p(hh)}:${p(mm)}`;
}

/** «Выгрузка из 1С (демо), загружена 10 октября 2026, 18:00» */
export function sourceLine(source: SourceRef, tz: string): string {
  return `${source.title}, загружена ${formatLoadedAt(source.loadedAt, tz)}`;
}

/** Сумма в тексте: рубли без копеек, если копеек нет, иначе с копейками. */
export function moneyText(v: Dec): string {
  return v.eq(v.toDecimalPlaces(0)) ? rub(v) : rub2(v);
}

/** Обычное число с запятой: ставка, вес, доля. До четырёх знаков, лишние нули убираются. */
export function numText(v: Dec | number, places = 4): string {
  return dec(v).toDecimalPlaces(places).toFixed().replace('.', ',');
}

/** Число в выражении без показателя степени. */
export function lit(v: Dec | number | string): string {
  return dec(v).toFixed();
}

/** Журнал шагов: выдаёт сквозные номера s1, s2, ... */
export class StepLog {
  readonly steps: FormulaStep[] = [];

  add(step: Omit<FormulaStep, 'id'>): FormulaStep {
    const full: FormulaStep = { ...step, id: `s${this.steps.length + 1}` };
    this.steps.push(full);
    return full;
  }
}

// ===== Вычисление выражений =====

type Token =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | ',' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ') {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ t: 'num', v: src.slice(i, j) });
      i = j;
    } else if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if ('+-*/(),'.includes(c)) {
      out.push({ t: 'op', v: c as '+' });
      i++;
    } else {
      throw new Error(`Недопустимый символ «${c}» в выражении: ${src}`);
    }
  }
  return out;
}

/**
 * Вычисляет выражение шага. `resolve` отдаёт результат ранее вычисленного шага по номеру,
 * для неизвестного номера он должен бросить исключение.
 */
export function evalExpression(src: string, resolve: (id: string) => Dec): Dec {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (v?: string): Token => {
    const tok = tokens[pos];
    if (!tok || (v !== undefined && tok.v !== v)) throw new Error(`Ошибка разбора выражения: ${src}`);
    pos++;
    return tok;
  };

  function expr(): Dec {
    let left = term();
    for (;;) {
      const tok = peek();
      if (tok?.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        pos++;
        const right = term();
        left = tok.v === '+' ? left.plus(right) : left.minus(right);
      } else return left;
    }
  }

  function term(): Dec {
    let left = unary();
    for (;;) {
      const tok = peek();
      if (tok?.t === 'op' && (tok.v === '*' || tok.v === '/')) {
        pos++;
        const right = unary();
        if (tok.v === '/' && right.isZero()) throw new Error(`Деление на ноль: ${src}`);
        left = tok.v === '*' ? left.times(right) : left.div(right);
      } else return left;
    }
  }

  function unary(): Dec {
    const tok = peek();
    if (tok?.t === 'op' && tok.v === '-') {
      pos++;
      return unary().neg();
    }
    return primary();
  }

  function primary(): Dec {
    const tok = eat();
    if (tok.t === 'num') return dec(tok.v);
    if (tok.t === 'op' && tok.v === '(') {
      const v = expr();
      eat(')');
      return v;
    }
    if (tok.t === 'id') {
      const next = peek();
      if (next?.t === 'op' && next.v === '(') {
        pos++;
        const args: Dec[] = [expr()];
        while (peek()?.t === 'op' && peek()!.v === ',') {
          pos++;
          args.push(expr());
        }
        eat(')');
        switch (tok.v) {
          case 'max':
            return D.max(...args);
          case 'min':
            return D.min(...args);
          case 'round2':
            if (args.length !== 1) throw new Error(`round2 принимает один аргумент: ${src}`);
            return round2(args[0]!);
          default:
            throw new Error(`Неизвестная функция ${tok.v}: ${src}`);
        }
      }
      return resolve(tok.v);
    }
    throw new Error(`Ошибка разбора выражения: ${src}`);
  }

  const value = expr();
  if (pos !== tokens.length) throw new Error(`Лишние символы в выражении: ${src}`);
  return value;
}

/** Допуск сравнения денег в проверках: на много порядков меньше копейки, но больше шума Decimal. */
export const VERIFY_TOLERANCE = dec('1e-9');

/**
 * Проверяет шаги: номера уникальны, ссылки идут только назад, результат каждого шага равен
 * вычислению его выражения. Возвращает список нарушений, пустой при успехе.
 */
export function verifySteps(steps: FormulaStep[]): string[] {
  const problems: string[] = [];
  const done = new Map<string, Dec>();
  for (const s of steps) {
    if (done.has(s.id)) problems.push(`${s.id}: номер повторяется`);
    try {
      const v = evalExpression(s.expression, (id) => {
        const r = done.get(id);
        if (r === undefined) throw new Error(`ссылка на неизвестный или более поздний шаг ${id}`);
        return r;
      });
      if (v.minus(s.result).abs().gt(VERIFY_TOLERANCE)) {
        problems.push(`${s.id}: выражение «${s.expression}» даёт ${v.toString()}, в шаге ${s.result.toString()}`);
      }
    } catch (e) {
      problems.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    done.set(s.id, s.result);
  }
  return problems;
}
