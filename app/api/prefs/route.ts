import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { BodyError, readJson } from '@/lib/auth/request';
import { failure, json, requireApiAuth } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { getPrefs, markOnboardingSeen } from '@/lib/prefs/prefs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  /** Обучение показано: только true, обратно «непройденным» его не сделать из интерфейса */
  onboardingSeen: z.literal(true),
});

/** Настройки пользователя: сейчас только время, когда закрыто обучение. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: false });
    if (!gate.ok) return gate.res;
    return json(await getPrefs(getDb(), gate.auth.userId));
  } catch (e) {
    return failure('prefs/get', e);
  }
}

/** Отметить обучение показанным. Идемпотентно: время первого закрытия не меняется. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const gate = await requireApiAuth(req, { mutating: true });
    if (!gate.ok) return gate.res;
    await readJson(req, Body);
    const prefs = await markOnboardingSeen(getDb(), { userId: gate.auth.userId, nowMs: Date.now() });
    return json(prefs);
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'Некорректный запрос', code: 'invalid' }, 400);
    return failure('prefs/set', e);
  }
}
