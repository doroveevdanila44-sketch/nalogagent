import {
  dataKind,
  formatPeriod,
  type CalcData,
  type DashboardInput,
  type Moment,
  type PeriodKind,
} from '@/lib/calc';
import { buildAnswer, resultSources } from './answers';
import { changeOptions, clarificationFor, entityChoices, narrowChoices, periodChoices, taxChoices, TAX_LABEL } from './clarify';
import {
  answerKind,
  buildInterpretation,
  extractFields,
  sanitizeFields,
  type AnswerKind,
  type InterpretContext,
} from './interpret';
import type { LlmProvider } from './provider';
import { classify, type Route } from './router';
import {
  BOUNDARY,
  CAPABILITIES,
  CLARIFY,
  CLARIFY_ENTITY,
  CLARIFY_SCENARIO,
  CLARIFY_SCENARIO_ALL,
  FAILURE_FALLBACK,
  FAREWELLS,
  GREETING_ROTATION,
  GUARD_FALLBACK,
  REFUSALS,
  THANKS,
  greetingFor,
} from './templates';
import { buildForecastAnswer } from './forecast-2027';
import { buildTaxAnswer, paymentLines } from './tax-answer';
import { checkNumbers, normalize } from './text';
import { canDoLine, explainUnsupported, type ExplainContext } from './unsupported';
import type {
  AgentReply,
  CalcResult,
  EntityRef,
  Intent,
  Interpretation,
  ParseContext,
  Pending,
  QuickReply,
  Slot,
  Understanding,
} from './types';

/** Счётчики по кругу хранятся в базе (agent_state). Пайплайн получает их как функции. */
export interface Counters {
  nextRefusal(): Promise<number>;
  nextGreeting(): Promise<number>;
}

export interface PipelineInput {
  question: string;
  entities: EntityRef[];
  input: DashboardInput;
  /** Снимок данных расчётного сервиса: из него calcTax считает налог за период */
  data: CalcData;
  now: Moment;
  /** Часовой пояс приложения: для времени загрузки источника в «Как посчитано» */
  tz?: string;
  provider: LlmProvider;
  counters: Counters;
  pending: Pending | null;
  lastIntent: Intent | null;
  /** Понимание прошлого ответа (или того, к которому относится нажатая кнопка) */
  previous?: Interpretation | null;
  /** Чего агент ждал в ответ на уточняющий вопрос */
  awaiting?: Slot[];
  /** Сообщение пришло с кнопки: продолжает прежний вопрос безусловно */
  refine?: boolean;
  /** Сессия: с последнего сообщения прошло меньше четырёх часов */
  sessionActive: boolean;
  /** Сколько ответов агента уже было, для чередования уточнений */
  agentMessages: number;
}

const text = (cls: AgentReply['class'], body: string, extra: Partial<AgentReply> = {}): AgentReply => ({
  class: cls,
  text: body,
  tables: [],
  how: [],
  fromCalc: false,
  ...extra,
});

export function aliasesFor(name: string): string[] {
  const full = normalize(name).replace(/[«»"]/g, '').trim();
  const short = full.replace(/^(ооо|ип|ао|зао|оао|пао)\s+/, '');
  return [...new Set([short, full])].filter(Boolean);
}

/** Диапазон месяцев с данными в базе (из строк revenue_monthly, не из констант). */
export function dataRangeOf(data: CalcData): InterpretContext['data'] {
  if (data.revenue.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of data.revenue) {
    const k = r.year * 12 + (r.month - 1);
    lo = Math.min(lo, k);
    hi = Math.max(hi, k);
  }
  return {
    from: { year: Math.floor(lo / 12), month: (lo % 12) + 1 },
    to: { year: Math.floor(hi / 12), month: (hi % 12) + 1 },
  };
}

const KIND_LABEL: Record<PeriodKind, string> = {
  fact: 'факт',
  forecast: 'прогноз',
  mixed: 'факт и прогноз',
};

/** Карточка «Понял так» из понимания и признака данных. */
export function understandingOf(
  i: Interpretation,
  kind: PeriodKind,
  entities: EntityRef[],
  opts: { entityId?: string | null; period?: string } = {},
): Understanding {
  const names = new Map(entities.map((e) => [e.id, e.name]));
  let entity = 'Вся группа';
  if (opts.entityId && names.has(opts.entityId)) entity = names.get(opts.entityId)!;
  else if (i.entityMode === 'named') {
    const list = i.entities.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
    if (list.length > 0) entity = list.join(' и ');
  }
  const tax = `${TAX_LABEL[i.tax ?? 'vat']}${i.rate ? `, ставка ${i.rate}%` : ''}`;
  const period = opts.period ?? (i.period ? formatPeriod(i.period) : '');
  const notes = i.ambiguities
    .filter((a) => a.kind === 'assumed' && a.slot !== 'entity' && a.note)
    .map((a) => a.note!);
  return { entity, tax, period, kind, kindLabel: KIND_LABEL[kind], notes };
}

const LEGACY_INTENT: Partial<Record<AnswerKind, Intent>> = {
  rates: 'rates',
  warnings: 'warnings',
  fragmentation: 'fragmentation',
  deduct: 'deduct',
  cars: 'scenario',
};

/**
 * Конвейер ответа (AGENT.md):
 * вопрос → маршрутизатор → класс; для A: поля вопроса → понимание → (пояснение | уточнение |
 * расчёт calcTax | прежний раздел) → explain → предохранитель.
 */
export async function runPipeline(p: PipelineInput): Promise<AgentReply> {
  const previous = p.previous ?? null;
  const awaiting = p.awaiting ?? [];
  const route: Route = classify(p.question, {
    entities: p.entities,
    pending: p.pending,
    context: { today: p.now, awaiting, hasPrevious: previous !== null },
  });

  switch (route.cls) {
    case 'B': {
      if (route.kind === 'greeting') {
        // первое приветствие сессии по времени суток, повторные идут по кругу
        if (!p.sessionActive) return text('B', greetingFor(Math.floor(p.now.secondsOfDay / 3600)));
        const i = await p.counters.nextGreeting();
        return text('B', GREETING_ROTATION[i % GREETING_ROTATION.length]!);
      }
      const i = await p.counters.nextGreeting();
      return route.kind === 'thanks'
        ? text('B', THANKS[i % THANKS.length]!)
        : text('B', FAREWELLS[i % FAREWELLS.length]!);
    }
    case 'C':
      return text('C', CAPABILITIES);
    case 'D': {
      const i = await p.counters.nextRefusal();
      return text('D', REFUSALS[i % REFUSALS.length]!);
    }
    case 'F':
      return text('F', BOUNDARY, { intent: 'boundary' });
    case 'E':
      return text('E', CLARIFY[p.agentMessages % CLARIFY.length]!);
  }

  // класс A: сначала понять, что спросили
  const ictx: InterpretContext = {
    entities: p.entities,
    today: p.now,
    previous,
    awaiting,
    refine: Boolean(p.refine),
    data: dataRangeOf(p.data),
    nextYear: {
      year: p.input.ctx.rules.nextYear.year,
      deflatorKnown: p.input.ctx.rules.nextYear.deflatorKnown,
    },
  };

  let interp: Interpretation;
  try {
    // модель (когда подключена) только извлекает поля; всё остальное решает код
    const rawIn = p.provider.extract
      ? await p.provider.extract(p.question, ictx)
      : extractFields(p.question, ictx);
    interp = buildInterpretation(sanitizeFields(rawIn, ictx), ictx);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'parse' });
  }

  const ectx: ExplainContext = {
    entities: p.entities,
    today: p.now,
    data: ictx.data,
    nextYear: ictx.nextYear,
  };

  // что агент не берётся делать: объяснение вместо общего отказа
  if (interp.unsupported) return unsupportedReply(p, interp, ectx);

  // не хватает налога или периода: один короткий вопрос с кнопками
  const clar = clarificationFor(interp, p.entities, p.now);
  if (clar) {
    return text('A', clar.text, {
      quick: clar.quick,
      awaiting: clar.awaiting,
      interp,
      intent: 'amount',
    });
  }

  // следующий год: прогноз НДС по трём ставкам, сценарий calcTax
  if (interp.forecast) return forecastReply(p, interp, ectx);

  const kind = answerKind(interp);
  if (kind === 'amount') return amountReply(p, interp, ectx);
  if (kind === 'payment') return paymentReply(p, interp, ectx);
  return legacyReply(p, interp, kind);
}

// ===== Пояснение вместо отказа =====

async function unsupportedReply(p: PipelineInput, interp: Interpretation, ectx: ExplainContext): Promise<AgentReply> {
  const u = interp.unsupported!;
  const canDo = canDoLine(ectx);

  // юридическая оценка схем: отказ из набора по кругу, как у вопросов вне темы
  if (u.kind === 'legal_assessment') {
    const i = await p.counters.nextRefusal();
    return text('D', `${REFUSALS[i % REFUSALS.length]!}\n\n${canDo}`, { unsupported: u.kind, interp });
  }

  let quick: QuickReply[] = [];
  if (u.kind === 'period_out_of_data' || u.kind === 'next_year') quick = periodChoices(p.now);
  else if (u.kind === 'other_tax') quick = taxChoices();
  else if (u.kind === 'unknown_entity') quick = entityChoices(p.entities);

  return text('A', [...explainUnsupported(u, ectx), canDo].join('\n\n'), {
    quick,
    unsupported: u.kind,
    interp,
    intent: 'amount',
  });
}

// ===== Сумма налога за период: calcTax =====

/** Ответ проходит через explain и предохранитель; числа берутся только из результата расчёта. */
async function finish(
  p: PipelineInput,
  result: CalcResult,
  extra: Partial<AgentReply>,
): Promise<AgentReply> {
  let body: string;
  try {
    body = await p.provider.explain(result, p.question);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'explain' });
  }
  const check = checkNumbers(body, [...resultSources(result), p.question]);
  if (!check.ok) {
    return text('A', GUARD_FALLBACK, {
      failure: `guard: числа вне расчёта: ${check.unknown.slice(0, 5).join(', ')}`,
      intent: result.intent,
    });
  }
  return {
    class: 'A',
    text: body,
    tables: result.tables,
    how: result.how,
    fromCalc: true,
    intent: result.intent,
    entityId: result.entityId ?? null,
    ...extra,
  };
}

/**
 * Прогноз следующего года. Над ответом карточка «Понял так» с допущениями одной строкой; кнопки
 * пересчитывают тот же сценарий с другим ростом выручки или сужают до юрлица.
 */
async function forecastReply(p: PipelineInput, interp: Interpretation, ectx: ExplainContext): Promise<AgentReply> {
  let answer;
  try {
    answer = buildForecastAnswer(
      { data: p.data, input: p.input, now: p.now, tz: p.tz ?? 'Asia/Kamchatka', canDo: canDoLine(ectx) },
      interp,
      p.entities,
    );
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'calc' });
  }
  const card = understandingOf({ ...interp, rate: null }, 'forecast', p.entities, {
    period: formatPeriod(interp.period!),
  });
  // допущения одной строкой; «налог не назван» не повторяется: прогноз всегда по НДС и он в карточке
  card.notes = [answer.note];

  return finish(p, answer.result, {
    understood: card,
    quick: answer.quick,
    change: changeOptions(p.entities, p.now),
    interp,
    intent: 'amount',
    calcs: answer.calcs,
  });
}

async function amountReply(p: PipelineInput, interp: Interpretation, ectx: ExplainContext): Promise<AgentReply> {
  const names = new Map(p.entities.map((e) => [e.id, e.name]));
  let answer;
  try {
    answer = buildTaxAnswer(
      { data: p.data, input: p.input, now: p.now, tz: p.tz ?? 'Asia/Kamchatka', canDo: canDoLine(ectx) },
      interp,
      names,
    );
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'calc' });
  }

  // «по группе» видно в карточке «Понял так», кнопки сужения под ответом: отдельного примечания нет
  const group = interp.entityMode !== 'named';

  return finish(p, answer.result, {
    understood: understandingOf(interp, answer.kind, p.entities),
    quick: group ? narrowChoices(p.entities) : [],
    change: changeOptions(p.entities, p.now),
    interp,
    intent: 'amount',
    calcs: answer.calcs,
  });
}

async function paymentReply(p: PipelineInput, interp: Interpretation, ectx: ExplainContext): Promise<AgentReply> {
  const tax = interp.tax ?? 'vat';
  const all = p.input.entities.map((e) => e.id);
  const scope = interp.entityMode === 'named' && interp.entities.length > 0 ? interp.entities : all;
  const line = paymentLines(
    { data: p.data, input: p.input, now: p.now, tz: p.tz ?? 'Asia/Kamchatka', canDo: canDoLine(ectx) },
    [tax],
    scope,
  );
  const paragraphs = [line ?? 'Ближайших платежей по этому налогу в справочнике сроков нет.'];
  const group = interp.entityMode !== 'named';
  const result: CalcResult = {
    intent: 'amount',
    paragraphs,
    tables: [],
    how: [
      'Сроки по справочнику: платёж не позднее 28 числа; НДС тремя равными частями после квартала.',
      ...(line ? [`График платежей: ${line}`] : []),
    ],
    entityId: scope.length === 1 ? scope[0] : null,
  };
  return finish(p, result, {
    understood: understandingOf(interp, 'forecast', p.entities, { period: 'ближайший срок' }),
    quick: group ? narrowChoices(p.entities) : [],
    change: changeOptions(p.entities, p.now),
    interp,
    intent: 'amount',
  });
}

// ===== Прежние разделы: ставки, пороги, вычет, признаки дробления, покупка машин =====

async function legacyReply(p: PipelineInput, interp: Interpretation, kind: AnswerKind): Promise<AgentReply> {
  const ctx: ParseContext = {
    entities: p.entities,
    pending: p.pending,
    // прошлый ответ о сумме налога не намерение прежних разделов
    lastIntent: p.lastIntent === 'amount' ? null : p.lastIntent,
    now: p.now,
  };

  let parsed;
  try {
    parsed = await p.provider.parse(p.question, ctx);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'parse' });
  }
  if (parsed.intent === 'boundary') return text('F', BOUNDARY, { intent: 'boundary' });

  // раздел определяет понимание вопроса, параметры (юрлицо, машины, цена) приходят из разбора
  const intent = LEGACY_INTENT[kind]!;
  const single = interp.entityMode === 'named' && interp.entities.length === 1 ? interp.entities[0]! : null;
  const entityId = single ?? parsed.entityId ?? null;
  const fields = { ...parsed, intent, entityId };

  // проверка полноты: один уточняющий вопрос
  if (intent === 'scenario') {
    const missing: Pending['missing'] = [];
    if (!fields.entityId) missing.push('entity');
    if (!fields.cars) missing.push('cars');
    if (fields.priceMln === null || fields.priceMln === undefined) missing.push('price');
    const ask = (miss: Pending['missing'], body: string) => {
      const pending: Pending = {
        intent: 'scenario',
        entityId: fields.entityId ?? null,
        cars: fields.cars ?? null,
        priceMln: fields.priceMln ?? null,
        missing: miss,
      };
      return text('A', body, {
        pending,
        intent: 'scenario',
        interp,
        quick: miss.includes('entity') ? narrowChoices(p.entities) : [],
      });
    };
    if (missing.length > 0) {
      const needEntity = missing.includes('entity');
      const needNumbers = missing.includes('cars') || missing.includes('price');
      return ask(missing, needEntity ? (needNumbers ? CLARIFY_SCENARIO_ALL : CLARIFY_ENTITY) : CLARIFY_SCENARIO);
    }
    if (fields.cars! < 1 || fields.cars! > 20 || fields.priceMln! <= 0) {
      return text('A', CLARIFY_SCENARIO, {
        pending: {
          intent: 'scenario',
          entityId: fields.entityId,
          cars: null,
          priceMln: null,
          missing: ['cars', 'price'],
        },
        intent: 'scenario',
        interp,
      });
    }
  }

  const only = interp.entityMode === 'named' && interp.entities.length > 1 ? interp.entities : undefined;
  let result: CalcResult;
  try {
    result = buildAnswer({ ...fields, intent }, { input: p.input, now: p.now, only });
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'calc' });
  }

  // карточка у ответов с налогом и периодом; вычет и признаки дробления это пояснения без периода
  const withCard = kind === 'rates' || kind === 'warnings' || kind === 'cars';
  const year = { kind: 'year', year: p.now.year } as const;
  const narrow = withCard && interp.entityMode !== 'named' && !result.entityId && kind !== 'cars';
  const yearLabel = formatPeriod(year);
  const dk = withCard ? dataKind(p.data, year) : 'mixed';

  return finish(p, result, {
    understood: withCard
      ? understandingOf(
          { ...interp, tax: 'vat', period: year, rate: kind === 'rates' ? interp.rate : null },
          dk,
          p.entities,
          { entityId: result.entityId ?? undefined, period: yearLabel },
        )
      : null,
    quick: narrow ? narrowChoices(p.entities) : [],
    change: withCard ? changeOptions(p.entities, p.now) : null,
    interp: {
      ...interp,
      entities: result.entityId ? [result.entityId] : interp.entities,
      entityMode: result.entityId ? 'named' : interp.entityMode,
    },
    intent: result.intent,
  });
}
