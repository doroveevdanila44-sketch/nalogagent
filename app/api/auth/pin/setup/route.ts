import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MSG } from '@/lib/auth/config';
import { BodyError, isSameOrigin, readJson } from '@/lib/auth/request';
import { ctxFromRequest, failure, json, setDeviceCookie, setSessionCookie, tokensFromRequest } from '@/lib/auth/server';
import { setupPin } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const body = await readJson(req, Body);
    const { deviceToken } = tokensFromRequest(req);
    const r = await setupPin(ctxFromRequest(req), { deviceToken, pin: body.pin });
    if (r.kind === 'forbidden') return json({ error: MSG.weakPin, code: 'weak_pin' }, 422);
    if (r.kind === 'invalid') return json({ error: 'PIN состоит из 4 цифр', code: 'invalid' }, 400);
    if (r.kind === 'unauthorized') return json({ error: 'Требуется вход', code: 'unauthorized' }, 401);
    const res = json({ ok: true, csrf: r.csrf });
    setSessionCookie(res, r.sessionToken);
    if (deviceToken) setDeviceCookie(res, deviceToken);
    return res;
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'PIN состоит из 4 цифр', code: 'invalid' }, 400);
    return failure('auth/pin/setup', e);
  }
}
