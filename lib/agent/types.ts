import type { CalcResult as TaxCalc, Moment, Period, PeriodKind, WhatIfRequest } from '@/lib/calc';
import type { WhatIfSnapshot } from '@/lib/provenance/whatif';
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
  /** «Что если»: пересчёт года при условии, которого в данных нет (машины, рост выручки) */
  | 'whatif'
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
  /** Узкая таблица на несколько числовых столбцов: плотные поля, названия строк переносятся по словам */
  dense?: boolean;
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
  calcs?: { result: TaxCalc; scope: string[] | 'all'; comparison?: WhatIfSnapshot }[];
  /** Карточка с полями «Что если купим N машин»: вопрос с недостающим или правка принятых значений */
  form?: FleetForm | null;
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
  /** Карточка с полями «Что если купим N машин»; null у остальных ответов */
  form: FleetForm | null;
}

// ===== Карточка «Что если купим N машин» =====

/** Цены одной машины в карточке; `null`: не заполнено. */
export interface FleetFormUnit {
  cost: number | null;
  rentPerDay: number | null;
}

/** Значения полей карточки. Числа в рублях, как ввёл человек; `null`: не заполнено. */
export interface FleetFormValues {
  entityId: string | null;
  cars: number | null;
  /** Переключатель «Все машины одинаковые»: общие `cost` и `rentPerDay`; выключен: цены в `units` */
  same: boolean;
  cost: number | null;
  /** Переключатель «с НДС / без НДС»: относится к стоимости покупки */
  costWithVat: boolean;
  rentPerDay: number | null;
  /** Цены по машинам (до 10), когда машины разные; пусто у одинаковых */
  units: FleetFormUnit[];
  rentDays: number;
  /** Первый месяц сдачи 0..11 */
  startMonth: number;
  /** Расходы на машину в месяц; null: не названы */
  expenses: number | null;
}

/** Обязательные поля, которых агент не нашёл в вопросе. */
export type FleetFormField = 'entity' | 'cars' | 'cost' | 'rent';

export interface FleetForm {
  /** ask: агент спрашивает недостающее; edit: «Изменить» под ответом, поля с введёнными значениями */
  mode: 'ask' | 'edit';
  values: FleetFormValues;
  /** Не названо в вопросе: поле подсвечено, пока пустое, и без него «Рассчитать» не работает */
  missing: FleetFormField[];
  /** Всегда false: «с НДС» (покупка у дилера) стоит по умолчанию и виден в поле, подтверждать не нужно. Поле осталось для ранее сохранённых ответов */
  confirmVat: boolean;
  /** Юрлица для кнопок: Альфа, Бета, Дельта, Гамма, Эпсилон */
  entities: { id: string; label: string }[];
  /** Месяцы начала сдачи: со следующего за идущим до декабря */
  months: { value: number; label: string }[];
  /** Быстрые варианты цены, пока значение не названо: стоимость машины и цена сдачи в сутки */
  quick: { cost: number[]; rent: number[] };
  /** Сообщение над полями: что не так с введённым */
  note: string | null;
}

/** Отправка карточки: все обязательные поля заполнены. Проверяется на сервере. */
export interface FleetFormSubmit {
  entityId: string;
  cars: number;
  /** Одинаковые машины: общая стоимость и цена сдачи; разные: null, цены в `units` */
  cost: number | null;
  costWithVat: boolean;
  rentPerDay: number | null;
  /** Разные машины: цены по порядку, по одной на машину */
  units: { cost: number; rentPerDay: number }[] | null;
  rentDays: number;
  startMonth: number;
  expenses: number | null;
}

/** Строка происхождения под ответом и число расчётов за ней (панель, Excel, проверка, передача). */
export interface TurnProvenance {
  line: SourceLineData;
  count: number;
  /** Что понято в вопросе: по нему «Сформировать документ» подставляет юрлицо и период */
  doc?: { entityIds: string[]; period: Period | null; tax: 'vat' | 'usn' | 'profit' | null };
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
 *  whatif         «что если купим N машин», «что если выручка вырастет на X%»: пересчёт текущего года
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
  | 'cars'
  | 'whatif';

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
/**
 * Почему следующий год не посчитать:
 *  limits  вопрос про утверждённые лимиты и пороги, дефлятора ещё нет
 *  tax     прогноз считается только по НДС
 *  mixed   период захватывает текущий и следующий годы
 *  other   такой вопрос (платёж, вычет) на следующий год не считается
 */
export type NextYearReason = 'limits' | 'tax' | 'mixed' | 'other';

export type Unsupported =
  | { kind: 'period_out_of_data'; period: Period }
  | { kind: 'next_year'; year: number; period: Period; reason: NextYearReason }
  | { kind: 'other_tax'; name: string }
  | { kind: 'unknown_entity'; name: string }
  | { kind: 'legal_assessment' }
  /** Названное значение вне допустимых границ («100 машин», «40 дней», «на 1000%»): ответ называет границу */
  | { kind: 'bad_value'; message: string };

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
  /**
   * Прогноз следующего года: календарный год и рост выручки в процентах. Считает calcTax по
   * сценарию; null или поля нет, если вопрос не про следующий год.
   */
  forecast?: { year: number; growth: number } | null;
  /**
   * Сценарий «что если»: что именно изменится (машины, процент, сумма). Юрлицо берётся из
   * `entities`; пока оно не названо, агент спрашивает. null или поля нет у остальных вопросов.
   */
  whatIf?: WhatIfRequest | null;
  /** Агент спросил «Для остальных такая же цена?»: короткое «да» или «нет» отвечает на это */
  restAsk?: boolean;
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
