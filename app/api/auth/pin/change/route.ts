import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { HEADER_CSRF, MSG } from '@/lib/auth/config';
import { BodyError, isSameOrigin, readJson } from '@/lib/auth/request';
import { ctxFromRequest, failure, json, tokensFromRequest } from '@/lib/auth/server';
import { changePin, csrfValid } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  currentPin: z.string().regex(/^\d{4}$/),
  newPin: z.string().regex(/^\d{4}$/),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const { deviceToken, sessionToken } = tokensFromRequest(req);
    if (!sessionToken || !csrfValid(sessionToken, req.headers.get(HEADER_CSRF))) {
      return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    }
    const body = await readJson(req, Body);
    const r = await changePin(ctxFromRequest(req), {
      deviceToken,
      sessionToken,
      currentPin: body.currentPin,
      newPin: body.newPin,
    });
    switch (r.kind) {
      case 'ok':
        return json({ ok: true });
      case 'wrong':
        return json({ error: `Неверный PIN. Осталось попыток: ${r.attemptsLeft}`, code: 'wrong_pin', attemptsLeft: r.attemptsLeft }, 401);
      case 'blocked':
        return json({ error: MSG.pinBlocked, code: 'pin_blocked' }, 423);
      case 'forbidden':
        return json({ error: MSG.weakPin, code: 'weak_pin' }, 422);
      case 'invalid':
        return json({ error: 'PIN состоит из 4 цифр', code: 'invalid' }, 400);
      default:
        return json({ error: 'Требуется вход', code: 'unauthorized' }, 401);
    }
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'PIN состоит из 4 цифр', code: 'invalid' }, 400);
    return failure('auth/pin/change', e);
  }
}
