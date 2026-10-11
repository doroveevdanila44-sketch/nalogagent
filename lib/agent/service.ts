import { and, desc, eq, sql } from 'drizzle-orm';
import { dashboardInput } from '@/lib/calc/service';
import { MissingRuleError } from '@/lib/calc/rules';
import { momentFromEpoch } from '@/lib/calc/time';
import type { Db } from '@/lib/db/client';
import { loadCalcData } from '@/lib/db/queries';
import { agentState, chatMessages, llmUsage } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { aliasesFor, runPipeline } from './pipeline';
import type { LlmProvider } from './provider';
import { getProvider } from './provider-factory';
import type {
  AgentReply,
  ChangeOptions,
  ChatTurn,
  EntityRef,
  Intent,
  Interpretation,
  Pending,
  QuickReply,
  Slot,
  Table,
  Understanding,
  Unsupported,
} from './types';

const SESSION_GAP_MS = 4 * 3_600_000;
export const HISTORY_LIMIT = 50;
const MAX_QUESTION = 1000;

/** Содержимое jsonb chat_messages.calc */
interface StoredCalc {
  tables?: Table[];
  how?: string[];
  fromCalc?: boolean;
  pending?: Pending | null;
  intent?: Intent | null;
  entityId?: string | null;
  /** Карточка «Понял так» */
  understood?: Understanding | null;
  /** Кнопки быстрых ответов */
  quick?: QuickReply[];
  /** Варианты по «Изменить» */
  change?: ChangeOptions | null;
  /** Понимание вопроса для склейки с коротким ответом */
  interp?: Interpretation | null;
  awaiting?: Slot[];
  unsupported?: Unsupported['kind'] | null;
}

function toTurn(r: typeof chatMessages.$inferSelect): ChatTurn {
  const calc = (r.calc ?? {}) as StoredCalc;
  return {
    id: r.id,
    role: r.role === 'user' ? 'user' : 'agent',
    class: (r.class as ChatTurn['class']) ?? null,
    text: r.content,
    tables: calc.tables ?? [],
    how: calc.how ?? [],
    fromCalc: calc.fromCalc ?? false,
    createdAt: r.createdAt.toISOString(),
    understood: calc.understood ?? null,
    quick: calc.quick ?? [],
    change: calc.change ?? null,
  };
}

/** Последние 50 сообщений по возрастанию времени. */
export async function loadHistory(db: Db, userId: string): Promise<ChatTurn[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(HISTORY_LIMIT);
  return rows.reverse().map(toTurn);
}

export async function handleChat(
  db: Db,
  args: {
    userId: string;
    question: string;
    nowMs?: number;
    provider?: LlmProvider;
    /** Ответ, к которому относится нажатая кнопка: его понимание вопроса продолжается */
    baseId?: number;
  },
): Promise<{ user: ChatTurn; agent: ChatTurn }> {
  const started = Date.now();
  const nowMs = args.nowMs ?? started;
  const { appTz } = getEnv();
  const now = momentFromEpoch(nowMs, appTz);
  const question = args.question.trim().slice(0, MAX_QUESTION);
  const provider = args.provider ?? getProvider();
  const nowDate = new Date(nowMs);

  await db.insert(agentState).values({ userId: args.userId }).onConflictDoNothing();
  const [state] = await db.select().from(agentState).where(eq(agentState.userId, args.userId)).limit(1);

  const [lastAgent] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.userId, args.userId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);

  // Кнопка под ответом продолжает именно тот ответ, а не последний в ленте
  let base = lastAgent;
  let refine = false;
  if (args.baseId !== undefined) {
    const [row] = await db
      .select()
      .from(chatMessages)
      .where(
        and(eq(chatMessages.id, args.baseId), eq(chatMessages.userId, args.userId), eq(chatMessages.role, 'agent')),
      )
      .limit(1);
    if (row) {
      base = row;
      refine = true;
    }
  }
  const lastCalc = (base?.role === 'agent' ? base.calc : null) as StoredCalc | null;

  // Один снимок данных на дашборд, чат и расчётный сервис
  const data = await loadCalcData(db, now);

  // Нет правил на текущий год (например, в январе, пока не добавлены записи): честный ответ вместо сбоя
  let input: ReturnType<typeof dashboardInput> | null = null;
  try {
    input = dashboardInput(data);
  } catch (e) {
    if (!(e instanceof MissingRuleError)) throw e;
  }
  const entities: EntityRef[] = (input?.entities ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    aliases: aliasesFor(e.name),
  }));

  const [{ n: agentMessages }] = (await db.execute(
    sql`select count(*)::int as n from chat_messages where user_id = ${args.userId} and role = 'agent'`,
  )).rows as { n: number }[];

  const sessionActive = Boolean(
    state?.lastActive && nowMs - state.lastActive.getTime() < SESSION_GAP_MS,
  );

  const bump = async (column: 'refusalIndex' | 'greetIndex'): Promise<number> => {
    const col = column === 'refusalIndex' ? agentState.refusalIndex : agentState.greetIndex;
    const rows = await db
      .update(agentState)
      .set({ [column]: sql`${col} + 1` })
      .where(eq(agentState.userId, args.userId))
      .returning({ used: sql<number>`${col} - 1` });
    return rows[0]?.used ?? 0;
  };

  let reply: AgentReply;
  try {
    if (!input) {
      reply = {
        class: 'E',
        text: 'Нет правил НДС на текущий год, поэтому посчитать не могу. Нужно добавить записи в справочник правил.',
        tables: [],
        how: [],
        fromCalc: false,
        failure: 'rules_missing',
      };
    } else {
      reply = await runPipeline({
        question,
        entities,
        input,
        data,
        now,
        tz: appTz,
        provider,
        counters: { nextRefusal: () => bump('refusalIndex'), nextGreeting: () => bump('greetIndex') },
        pending: lastCalc?.pending ?? null,
        lastIntent: lastCalc?.intent ?? null,
        previous: lastCalc?.interp ?? null,
        awaiting: lastCalc?.awaiting ?? [],
        refine,
        sessionActive,
        agentMessages: agentMessages ?? 0,
      });
    }
  } catch (e) {
    console.error('[agent] сбой конвейера', e instanceof Error ? e.name : 'Error');
    reply = {
      class: 'E',
      text: 'Не получилось выполнить расчёт. Повторите вопрос чуть позже.',
      tables: [],
      how: [],
      fromCalc: false,
      failure: 'pipeline',
    };
  }

  const stored: StoredCalc = {
    tables: reply.tables,
    how: reply.how,
    fromCalc: reply.fromCalc,
    pending: reply.pending ?? null,
    intent: reply.intent ?? null,
    entityId: reply.entityId ?? null,
    understood: reply.understood ?? null,
    quick: reply.quick ?? [],
    change: reply.change ?? null,
    interp: reply.interp ?? null,
    awaiting: reply.awaiting ?? [],
    unsupported: reply.unsupported ?? null,
  };

  const [userRow, agentRow] = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(chatMessages)
      .values({ userId: args.userId, role: 'user', content: question, createdAt: nowDate })
      .returning();
    const [a] = await tx
      .insert(chatMessages)
      .values({
        userId: args.userId,
        role: 'agent',
        class: reply.class,
        content: reply.text,
        calc: stored,
        createdAt: new Date(nowMs + 1),
      })
      .returning();
    await tx.update(agentState).set({ lastActive: nowDate }).where(eq(agentState.userId, args.userId));
    return [u!, a!] as const;
  });

  if (reply.class === 'A' || reply.failure) {
    await db.insert(llmUsage).values({
      provider: provider.name,
      latencyMs: Date.now() - started,
      ok: !reply.failure,
      note: reply.failure ?? null,
    });
  }

  return { user: toTurn(userRow), agent: toTurn(agentRow) };
}
