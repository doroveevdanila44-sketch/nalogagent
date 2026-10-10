import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/auth/request';
import { ctxFromRequest, failure, json, tokensFromRequest } from '@/lib/auth/server';
import { lockSession } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Принудительная блокировка на PIN. Безопасная операция: CSRF-токен не требуется, чтобы запрос
 * мог уйти через sendBeacon при закрытии вкладки, где заголовки задать нельзя. Origin проверяется.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const { sessionToken } = tokensFromRequest(req);
    await lockSession(ctxFromRequest(req), { sessionToken });
    return json({ ok: true });
  } catch (e) {
    return failure('auth/lock', e);
  }
}
