import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { handleChat, loadHistory } from '@/lib/agent/service';
import { FLEET_MAX_COST, FLEET_MAX_EXPENSES, FLEET_MAX_RENT_PER_DAY, WHATIF_MAX_CARS } from '@/lib/calc';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Карточка «Что если купим N машин» с заполненными полями. Границы те же, что проверяет расчётное ядро. */
const FleetForm = z.object({
  entityId: z.string().min(1).max(40),
  cars: z.number().int().min(1).max(WHATIF_MAX_CARS),
  cost: z.number().positive().max(FLEET_MAX_COST),
  costWithVat: z.boolean(),
  rentPerDay: z.number().positive().max(FLEET_MAX_RENT_PER_DAY),
  rentDays: z.number().int().min(1).max(31),
  startMonth: z.number().int().min(0).max(11),
  expenses: z.number().min(0).max(FLEET_MAX_EXPENSES).nullable(),
});

const Body = z
  .object({
    /** Текст вопроса; у карточки с полями его собирает сервер */
    message: z.string().trim().max(1000).optional(),
    /** Ответ, к которому относится нажатая кнопка («Изменить», быстрый ответ) */
    baseId: z.number().int().positive().optional(),
    form: FleetForm.optional(),
  })
  .refine((b) => b.form !== undefined || (b.message !== undefined && b.message.length > 0));

/** История: последние 50 сообщений. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    return json({ messages: await loadHistory(getDb(), gate.auth.userId) });
  } catch (e) {
    return failure('chat/history', e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const body = await readJson(req, Body);
    const turns = await handleChat(getDb(), {
      userId: gate.auth.userId,
      question: body.message ?? '',
      baseId: body.baseId,
      form: body.form,
    });
    return json(turns);
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Введите вопрос', code: 'invalid' }, 400);
    return failure('chat', e);
  }
}
