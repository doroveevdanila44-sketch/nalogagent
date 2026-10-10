import type { Moment } from '@/lib/calc/time';

/** A по теме, B этикет, C служебное, D вне темы, E непонятное, F за границей продукта */
export type AgentClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type Intent =
  | 'rates'
  | 'warnings'
  | 'fragmentation'
  | 'forecast'
  | 'deduct'
  | 'profit'
  | 'scenario'
  | 'boundary';

export interface EntityRef {
  id: string;
  name: string;
  /** Нормализованные имена для поиска: «альфа», «ооо альфа» */
  aliases: string[];
}

/** Незавершённый запрос: агент задал уточняющий вопрос и ждёт недостающее. */
export interface Pending {
  intent: Intent;
  entityId?: string | null;
  cars?: number | null;
  priceMln?: number | null;
  missing: ('entity' | 'cars' | 'price')[];
}

export interface ParseContext {
  entities: EntityRef[];
  pending: Pending | null;
  /** Намерение предыдущего ответа, для «а по Бете?» */
  lastIntent: Intent | null;
  now: Moment;
}

export interface ParsedIntent {
  intent: Intent | 'unknown';
  entityId?: string | null;
  cars?: number | null;
  priceMln?: number | null;
}

export interface Table {
  head: string[];
  rows: string[][];
  /** Ячейки, которые надо выделить как лучшие: [строка, столбец] */
  best?: [number, number][];
  /** Последняя строка итоговая */
  totalRow?: boolean;
}

/** Результат расчёта: единственный источник чисел для ответа. */
export interface CalcResult {
  intent: Intent;
  /** Абзацы с числами, собранные кодом из lib/calc */
  paragraphs: string[];
  tables: Table[];
  /** Содержимое блока «Как посчитано» */
  how: string[];
  entityId?: string | null;
}

export interface AgentReply {
  class: AgentClass;
  text: string;
  tables: Table[];
  how: string[];
  /** true: ответ собран из чисел калькулятора, показываем подпись «Цифры из калькулятора» */
  fromCalc: boolean;
  pending?: Pending | null;
  intent?: Intent | null;
  entityId?: string | null;
  /** Сбой предохранителя или модели: пишется в журнал */
  failure?: string | null;
}

export interface ChatTurn {
  id: number;
  role: 'user' | 'agent';
  class: AgentClass | null;
  text: string;
  tables: Table[];
  how: string[];
  fromCalc: boolean;
  createdAt: string;
}
