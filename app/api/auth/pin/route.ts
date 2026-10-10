import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MSG } from '@/lib/auth/config';
import { BodyError, isSameOrigin, readJson } from '@/lib/auth/request';
import { ctxFromRequest, failure, json, setDeviceCookie, setSessionCookie, tokensFromRequest } from '@/lib/auth/server';
import { verifyPinLogin } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ pin: z.string().regex(/^\d{4}$/) });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const body = await readJson(req, Body);
    const { deviceToken } = tokensFromRequest(req);
    const r = await verifyPinLogin(ctxFromRequest(req), { deviceToken, pin: body.pin });

    switch (r.kind) {
      case 'ok': {
        const res = json({ ok: true, csrf: r.csrf });
        setSessionCookie(res, r.sessionToken);
        if (deviceToken) setDeviceCookie(res, deviceToken);
        return res;
      }
      case 'wrong':
        return json(
          { error: `Неверный PIN. Осталось попыток: ${r.attemptsLeft}`, code: 'wrong_pin', attemptsLeft: r.attemptsLeft },
          401,
        );
      case 'blocked':
        return json({ error: MSG.pinBlocked, code: 'pin_blocked' }, 423);
      case 'needPinSetup':
        return json({ error: 'Требуется вход по паролю', code: 'need_password' }, 401);
      default:
        return json({ error: 'Требуется вход', code: 'unauthorized' }, 401);
    }
  } catch (e) {
    if (e instanceof BodyError) return json({ error: 'PIN состоит из 4 цифр', code: 'invalid' }, 400);
    return failure('auth/pin', e);
  }
}
