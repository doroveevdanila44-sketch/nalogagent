import { MONTH_NAMES, formatPeriod, type Moment } from '@/lib/calc';
import { dativeName, shortName } from './entities';
import type { EntityRef, Unsupported } from './types';

/**
 * Пояснения вместо общего отказа. В каждом ответе последняя строка «Что могу сейчас» с двумя-тремя
 * примерами вопросов. Числа здесь не пишутся: годы и месяцы берутся из данных и из вопроса.
 */
export interface ExplainContext {
  entities: EntityRef[];
  today: Moment;
  /** Месяцы с данными в демо: первый и последний, месяц 1..12 */
  data: { from: { year: number; month: number }; to: { year: number; month: number } } | null;
  nextYear: { year: number; deflatorKnown: boolean } | null;
}

const monthName = (m: number) => MONTH_NAMES[m - 1]!;

/** «с января 2025 по декабрь 2026» */
export function dataRangeText(data: NonNullable<ExplainContext['data']>): string {
  const g = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `с ${g[data.from.month - 1]} ${data.from.year} по ${monthName(data.to.month)} ${data.to.year}`;
}

/** Последний завершённый месяц в пределах данных: пример для строки «Что могу сейчас». */
function exampleMonth(ctx: ExplainContext): string {
  const cur = ctx.today.year * 12 + ctx.today.month;
  let o = cur - 1;
  if (ctx.data) {
    const lo = ctx.data.from.year * 12 + (ctx.data.from.month - 1);
    const hi = ctx.data.to.year * 12 + (ctx.data.to.month - 1);
    o = Math.min(Math.max(o, lo), hi);
  }
  return monthName((o % 12) + 1);
}

/** «Что могу сейчас: …» с примерами, которые агент точно понимает. */
export function canDoLine(ctx: ExplainContext): string {
  const first = ctx.entities[0];
  const who = first ? ` по ${dativeName(shortName(first))}` : '';
  return (
    `Что могу сейчас: «НДС за ${exampleMonth(ctx)}${who}», «налог по УСН с начала года», ` +
    '«какая ставка выгоднее?».'
  );
}

const TAX_NOTE: Record<string, string> = {
  'страховые взносы':
    'Страховые взносы не считаю, в налоге по УСН они не учтены: сумму лучше уточнить у бухгалтера.',
  НДФЛ: 'НДФЛ я не считаю: это налог физических лиц, а я работаю с юрлицами группы.',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Абзацы пояснения без строки «Что могу сейчас» (её добавляет вызывающий, чтобы поставить после
 * отказа из набора). Для legal_assessment пояснения нет: там работает набор отказов.
 */
export function explainUnsupported(u: Unsupported, ctx: ExplainContext): string[] {
  const range = ctx.data ? dataRangeText(ctx.data) : null;
  switch (u.kind) {
    case 'period_out_of_data': {
      const label = formatPeriod(u.period);
      return [
        range
          ? `Данные в демо ${range}, за ${label} посчитать не могу.`
          : `За ${label} данных в демо нет.`,
      ];
    }
    case 'next_year': {
      const base = ctx.nextYear?.deflatorKnown
        ? `Правил на ${u.year} год в справочнике пока нет.`
        : `Лимиты ${u.year} пока не утверждены, жду дефлятор.`;
      return [range ? `${base} Данные в демо ${range}, поэтому расчёт на ${u.year} год не даю.` : base];
    }
    case 'other_tax': {
      const note = TAX_NOTE[u.name];
      return [
        `${capitalize(u.name)} я не считаю. Считаю НДС, налог по УСН и налог на прибыль по юрлицам группы.`,
        ...(note && u.name !== 'НДФЛ' ? [note] : []),
      ];
    }
    case 'unknown_entity': {
      const list = ctx.entities.map((e) => e.name).join(', ');
      return [`${u.name} нет в группе. Считаю по юрлицам группы: ${list}.`];
    }
    case 'legal_assessment':
      return [];
  }
}
