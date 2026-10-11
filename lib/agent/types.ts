import type { CalcResult as TaxCalc, Moment, Period, PeriodKind } from '@/lib/calc';
import type { SourceLineData } from '@/lib/provenance/line';

/** A по теме, B этикет, C служебное, D вне темы, E непонятное, F за границей продукта */
export type AgentClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type Intent =
  /** Налог за период, посчитанный calcTax */
  | 'amount'
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
  /** Карточка «Понял так» над результатом */
  understood?: Understanding | null;
  /** Кнопки быстрых ответов под сообщением: уточнение или сужение до юрлица */
  quick?: QuickReply[];
  /** Варианты по кнопке «Изменить» у карточки */
  change?: ChangeOptions | null;
  /** Понимание вопроса: по нему следующий короткий ответ продолжает запрос */
  interp?: Interpretation | null;
  /** Чего агент ждёт в ответ на уточняющий вопрос */
  awaiting?: Slot[];
  /** Вид пояснения, если агент не берётся за запрос */
  unsupported?: Unsupported['kind'] | null;
  /** Расчёты calcTax, из которых собран ответ: основа строки происхождения и действий */
  calcs?: { result: TaxCalc; scope: string[] | 'all' }[];
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
  understood: Understanding | null;
  quick: QuickReply[];
  change: ChangeOptions | null;
  /** Происхождение цифр ответа; null, если в ответе нет расчёта */
  provenance: TurnProvenance | null;
}

/** Строка происхождения под ответом и число расчётов за ней (панель, Excel, проверка, передача). */
export interface TurnProvenance {
  line: SourceLineData;
  count: number;
}

// ===== Понимание вопроса =====

/** Налог в вопросе. Те же значения, что у calcTax */
export type TaxKind = 'vat' | 'usn' | 'profit';

/** Ставка НДС, которую можно назвать в вопросе */
export type RateValue = 5 | 7 | 22;

/**
 * Что именно просят.
 *  rate           какая ставка у юрлица
 *  compare_rates  сравнить ставки, какая выгоднее
 *  forecast       прогноз налога
 *  threshold      порог освобождения, предупреждения
 *  payment        ближайший платёж, срок
 *  deduct, fragmentation, cars  прежние разделы агента (вычет, признаки дробления, покупка машин)
 * null: обычный вопрос «сколько налога», его считает calcTax.
 */
export type Scenario =
  | 'rate'
  | 'compare_rates'
  | 'forecast'
  | 'threshold'
  | 'payment'
  | 'deduct'
  | 'fragmentation'
  | 'cars';

export type Slot = 'entity' | 'tax' | 'period';

/**
 * Чего не хватает или что неоднозначно.
 *  missing  значения нет, без него не посчитать
 *  multiple названо несколько, нужно выбрать одно
 *  assumed  значения не было, взято по умолчанию (налог НДС, юрлицо группа, текущий квартал)
 */
export interface Ambiguity {
  slot: Slot;
  kind: 'missing' | 'multiple' | 'assumed';
  /** Для multiple: названные налоги */
  taxes?: TaxKind[];
  /** Для multiple: названные периоды */
  periods?: Period[];
  /** Для assumed: что именно допущено, одной фразой */
  note?: string;
}

/** Что агент не берётся делать, и почему. Объяснение строит unsupported.ts */
export type Unsupported =
  | { kind: 'period_out_of_data'; period: Period }
  | { kind: 'next_year'; year: number; period: Period }
  | { kind: 'other_tax'; name: string }
  | { kind: 'unknown_entity'; name: string }
  | { kind: 'legal_assessment' };

export interface Interpretation {
  /** Юрлица из группы по id; пусто для группы целиком и когда юрлицо не названо */
  entities: string[];
  /** named: названо; group: «все», «группа»; none: не названо, считаем по группе */
  entityMode: 'named' | 'group' | 'none';
  tax: TaxKind | null;
  period: Period | null;
  scenario: Scenario | null;
  /** Ставка НДС, если названа («по ставке 22%») */
  rate: RateValue | null;
  /** 0..1: насколько вопрос определён без домыслов */
  confidence: number;
  ambiguities: Ambiguity[];
  unsupported: Unsupported | null;
}

/** Карточка «Понял так» перед результатом. */
export interface Understanding {
  entity: string;
  tax: string;
  period: string;
  kind: PeriodKind;
  /** «факт», «прогноз», «факт и прогноз» */
  kindLabel: string;
  /** Что допущено без вопроса: юрлицо не названо, налог не назван */
  notes: string[];
}

/** Быстрый ответ-кнопка. text уходит в чат как сообщение пользователя. */
export interface QuickReply {
  label: string;
  text: string;
  group?: Slot;
}

/** Варианты по нажатию «Изменить». */
export interface ChangeOptions {
  entity: QuickReply[];
  tax: QuickReply[];
  period: QuickReply[];
}
