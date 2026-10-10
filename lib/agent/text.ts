/** Нормализация текста и проверка чисел («предохранитель»). Без зависимостей от БД и интерфейса. */

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_RE = /\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

/** Каноническая запись числа для сравнения: без пробелов, точка, без хвостовых нулей. */
function canonical(raw: string): string {
  const s = raw.replace(/ /g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/** Все числа текста в канонической записи. Неразрывные пробелы считаются разделителем разрядов. */
export function extractNumbers(text: string): string[] {
  const flat = text.replace(/[  ]/g, ' ').replace(/−/g, '-');
  const found = flat.match(NUMBER_RE) ?? [];
  return found.map(canonical);
}

/**
 * Допустимые числа: числа источников плюс их записи в миллионах (1 352 381 → 1,35 млн),
 * чтобы корректный пересказ другим форматом не считался выдумкой.
 */
export function allowedNumbers(sources: string[]): Set<string> {
  const base = sources.flatMap(extractNumbers);
  const out = new Set<string>(base);
  for (const c of base) {
    const n = Number(c);
    if (Number.isFinite(n) && Math.abs(n) >= 10_000) {
      for (const digits of [0, 1, 2, 3]) out.add(canonical((n / 1_000_000).toFixed(digits)));
    }
  }
  return out;
}

export interface NumberCheck {
  ok: boolean;
  /** Числа ответа, которых нет в расчёте */
  unknown: string[];
}

/**
 * Предохранитель: каждое число в тексте ответа обязано встречаться в расчёте
 * (в его абзацах, таблицах, блоке «Как посчитано») или в вопросе пользователя.
 */
export function checkNumbers(answer: string, allowedSources: string[]): NumberCheck {
  const allowed = allowedNumbers(allowedSources);
  const unknown = [...new Set(extractNumbers(answer).filter((n) => !allowed.has(n)))];
  return { ok: unknown.length === 0, unknown };
}
