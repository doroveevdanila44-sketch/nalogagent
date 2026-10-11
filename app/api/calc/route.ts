import { NextResponse, type NextRequest } from 'next/server';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { getEnv } from '@/lib/env';
import { TargetSchema } from '@/lib/provenance/schemas';
import { resolveTarget, TargetError } from '@/lib/provenance/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Расчёт для панели «Показать расчёт» и экрана «Проверить самому»: снимки CalcResult по запросам
 * (налог, период, юрлица, ставка, момент) или по сохранённому ответу чата. Числа считает calcTax
 * по тому же снимку данных, что дашборд и чат; здесь они только переупаковываются в JSON.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    const target = await readJson(req, TargetSchema);
    const items = await resolveTarget(getDb(), {
      userId: gate.auth.userId,
      target,
      nowMs: Date.now(),
      tz: getEnv().appTz,
    });
    return json({ items });
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    if (e instanceof TargetError) return json({ error: e.message, code: 'target' }, e.status);
    return failure('calc', e);
  }
}
