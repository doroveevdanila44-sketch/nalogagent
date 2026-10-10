import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_DEVICE, COOKIE_SESSION, HEADER_CSRF } from '@/lib/auth/config';
import { isSameOrigin } from '@/lib/auth/request';
import { clearCookie, ctxFromRequest, failure, json, tokensFromRequest } from '@/lib/auth/server';
import { csrfValid, logout } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const { deviceToken, sessionToken } = tokensFromRequest(req);
    if (sessionToken && !csrfValid(sessionToken, req.headers.get(HEADER_CSRF))) {
      return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    }
    await logout(ctxFromRequest(req), { deviceToken, sessionToken });
    const res = json({ ok: true });
    clearCookie(res, COOKIE_SESSION);
    clearCookie(res, COOKIE_DEVICE);
    return res;
  } catch (e) {
    return failure('auth/logout', e);
  }
}
