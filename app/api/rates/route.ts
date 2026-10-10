import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { momentFromEpoch } from '@/lib/calc/time';
import { getDb } from '@/lib/db/client';
import { entityTaxRegime, saveRateChoice } from '@/lib/db/queries';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  entityId: z.string().min(1).max(64),
  rate: z.union([z.literal(5), z.literal(7), z.literal(22)]),
});

/** Выбор ставки по юрлицу. Пишется в rate_choices с историей, действует последняя запись года. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const body = await readJson(req, Body);
    const db = getDb();
    const regime = await entityTaxRegime(db, body.entityId);
    if (!regime) return json({ error: 'Юрлицо не найдено', code: 'not_found' }, 404);
    // На ОСНО ставка НДС одна (22% с вычетами), выбирать нечего
    if (regime === 'osno') {
      return json({ error: 'Для юрлица на ОСНО ставка НДС одна', code: 'no_choice' }, 422);
    }
    const { year } = momentFromEpoch(Date.now(), getEnv().appTz);
    await saveRateChoice(db, { entityId: body.entityId, year, rate: body.rate, userId: gate.auth.userId });
    return json({ ok: true, entityId: body.entityId, rate: body.rate });
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    return failure('rates', e);
  }
}
