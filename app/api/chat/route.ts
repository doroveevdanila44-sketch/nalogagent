import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { clearHistory, handleChat, loadHistory } from '@/lib/agent/service';
import {
  FLEET_MAX_COST,
  FLEET_MAX_DIFFERENT,
  FLEET_MAX_EXPENSES,
  FLEET_MAX_RENT_PER_DAY,
  WHATIF_MAX_CARS,
} from '@/lib/calc';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Цены одной машины, когда машины разные. */
const FleetUnit = z.object({
  cost: z.number().positive().max(FLEET_MAX_COST),
  rentPerDay: z.number().positive().max(FLEET_MAX_RENT_PER_DAY),
});

/**
 * Карточка «Что если купим N машин» с заполненными полями. Границы те же, что проверяет расчётное ядро.
 * Одинаковые машины: общие `cost` и `rentPerDay`; разные: `units` по одной записи на машину (до 10).
 */
const FleetForm = z
  .object({
    entityId: z.string().min(1).max(40),
    cars: z.number().int().min(1).max(WHATIF_MAX_CARS),
    cost: z.number().positive().max(FLEET_MAX_COST).nullable().default(null),
    costWithVat: z.boolean(),
    rentPerDay: z.number().positive().max(FLEET_MAX_RENT_PER_DAY).nullable().default(null),
    units: z.array(FleetUnit).min(1).max(FLEET_MAX_DIFFERENT).nullable().default(null),
    rentDays: z.number().int().min(1).max(31),
    startMonth: z.number().int().min(0).max(11),
    expenses: z.number().min(0).max(FLEET_MAX_EXPENSES).nullable(),
  })
  .refine((f) => (f.units ? f.units.length === f.cars : f.cost !== null && f.rentPerDay !== null));

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

/** Очистить чат: стирает всю историю пользователя. Нужен вход, Origin и CSRF-токен, как у любого изменения. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const deleted = await clearHistory(getDb(), gate.auth.userId);
    return json({ deleted });
  } catch (e) {
    return failure('chat/clear', e);
  }
}
