import type { DashboardInput, Moment } from '@/lib/calc';
import { buildAnswer, resultSources } from './answers';
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
import { checkNumbers, normalize } from './text';
import type { AgentReply, EntityRef, Intent, ParseContext, Pending } from './types';

/** Счётчики по кругу хранятся в базе (agent_state). Пайплайн получает их как функции. */
export interface Counters {
  nextRefusal(): Promise<number>;
  nextGreeting(): Promise<number>;
}

export interface PipelineInput {
  question: string;
  entities: EntityRef[];
  input: DashboardInput;
  now: Moment;
  provider: LlmProvider;
  counters: Counters;
  pending: Pending | null;
  lastIntent: Intent | null;
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

/**
 * Конвейер ответа (AGENT.md):
 * вопрос → маршрутизатор → класс; для A: parse → полнота → калькулятор → explain → предохранитель.
 */
export async function runPipeline(p: PipelineInput): Promise<AgentReply> {
  const route: Route = classify(p.question, { entities: p.entities, pending: p.pending });

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

  // класс A
  const ctx: ParseContext = {
    entities: p.entities,
    pending: p.pending,
    lastIntent: p.lastIntent,
    now: p.now,
  };

  let parsed;
  try {
    parsed = await p.provider.parse(p.question, ctx);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'parse' });
  }

  if (parsed.intent === 'unknown') {
    return text('E', CLARIFY[p.agentMessages % CLARIFY.length]!, { entityId: parsed.entityId ?? null });
  }
  if (parsed.intent === 'boundary') return text('F', BOUNDARY, { intent: 'boundary' });

  // проверка полноты: один уточняющий вопрос
  if (parsed.intent === 'scenario') {
    const missing: Pending['missing'] = [];
    if (!parsed.entityId) missing.push('entity');
    if (!parsed.cars) missing.push('cars');
    if (parsed.priceMln === null || parsed.priceMln === undefined) missing.push('price');
    if (missing.length > 0) {
      const pending: Pending = {
        intent: 'scenario',
        entityId: parsed.entityId ?? null,
        cars: parsed.cars ?? null,
        priceMln: parsed.priceMln ?? null,
        missing,
      };
      // один вопрос на всё недостающее
      const needEntity = missing.includes('entity');
      const needNumbers = missing.includes('cars') || missing.includes('price');
      const question = needEntity ? (needNumbers ? CLARIFY_SCENARIO_ALL : CLARIFY_ENTITY) : CLARIFY_SCENARIO;
      return text('A', question, { pending, intent: 'scenario' });
    }
    if (parsed.cars! < 1 || parsed.cars! > 20 || parsed.priceMln! <= 0) {
      const pending: Pending = {
        intent: 'scenario',
        entityId: parsed.entityId,
        cars: null,
        priceMln: null,
        missing: ['cars', 'price'],
      };
      return text('A', CLARIFY_SCENARIO, { pending, intent: 'scenario' });
    }
  }

  const answerCtx = { input: p.input, now: p.now };
  let result;
  try {
    result = buildAnswer({ ...parsed, intent: parsed.intent }, answerCtx);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'calc' });
  }

  let body: string;
  try {
    body = await p.provider.explain(result, p.question);
  } catch {
    return text('A', FAILURE_FALLBACK, { failure: 'explain' });
  }

  // предохранитель: число вне расчёта значит ответ не уходит
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
    entityId: result.entityId ?? parsed.entityId ?? null,
  };
}
