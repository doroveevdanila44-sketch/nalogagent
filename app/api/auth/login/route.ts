import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AUTH, MSG } from '@/lib/auth/config';
import { BodyError, isSameOrigin, readJson } from '@/lib/auth/request';
import { ctxFromRequest, failure, json, setDeviceCookie, tokensFromRequest } from '@/lib/auth/server';
import { passwordLogin } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  login: z.string().min(1).max(AUTH.maxLoginLength),
  password: z.string().min(1).max(AUTH.maxPasswordLength),
});

// Тело запроса содержит пароль: не логируется ни здесь, ни в прокси.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!isSameOrigin(req)) return json({ error: 'Запрос отклонён', code: 'forbidden' }, 403);
    const body = await readJson(req, Body);
    const { deviceToken } = tokensFromRequest(req);
    const result = await passwordLogin(ctxFromRequest(req), {
      login: body.login,
      password: body.password,
      deviceToken,
    });

    if (result.kind === 'throttled') {
      const res = json({ error: MSG.throttled, code: 'throttled' }, 429);
      res.headers.set('Retry-After', String(result.retryAfterSec));
      return res;
    }
    if (result.kind === 'invalid') {
      return json({ error: MSG.invalidCredentials, code: 'invalid' }, 401);
    }
    const res = json(result.next === 'needPinSetup' ? { needPinSetup: true } : { needPin: true });
    setDeviceCookie(res, result.deviceToken);
    return res;
  } catch (e) {
    if (e instanceof BodyError) return json({ error: MSG.invalidCredentials, code: 'invalid' }, 400);
    return failure('auth/login', e);
  }
}
