import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_DEVICE } from '@/lib/auth/config';
import { clearCookie, ctxFromRequest, failure, json, setDeviceCookie, tokensFromRequest } from '@/lib/auth/server';
import { getAuthState } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Состояние для клиента: anonymous, needPinSetup, locked, ok. Для ok отмечает активность. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { deviceToken, sessionToken } = tokensFromRequest(req);
    const auth = await getAuthState(ctxFromRequest(req), { deviceToken, sessionToken });
    const res = json({ state: auth.state, ...(auth.state === 'ok' ? { csrf: auth.csrf } : {}) });
    if (auth.clearDeviceCookie) clearCookie(res, COOKIE_DEVICE);
    else if (auth.refreshDeviceCookie && deviceToken) setDeviceCookie(res, deviceToken);
    return res;
  } catch (e) {
    return failure('auth/state', e);
  }
}
