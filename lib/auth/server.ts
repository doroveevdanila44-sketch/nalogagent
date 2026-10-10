import { cookies, headers } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { getEnv } from '@/lib/env';
import { AUTH, COOKIE_DEVICE, COOKIE_SESSION, HEADER_CSRF } from './config';
import { clientIp, isSameOrigin } from './request';
import { csrfValid, getAuthState, lockSession, type AuthResult, type Ctx } from './service';

export function ctxFromRequest(req: Request): Ctx {
  return { db: getDb(), ip: clientIp(req.headers), userAgent: req.headers.get('user-agent') };
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function setDeviceCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_DEVICE, token, {
    httpOnly: true,
    secure: getEnv().secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH.deviceDays * 86_400,
  });
}

/** Сессионная cookie: без срока, умирает вместе с браузером. Срок на сервере 12 часов. */
export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_SESSION, token, {
    httpOnly: true,
    secure: getEnv().secureCookies,
    sameSite: 'lax',
    path: '/',
  });
}

export function clearCookie(res: NextResponse, name: string): void {
  res.cookies.set(name, '', {
    httpOnly: true,
    secure: getEnv().secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function tokensFromRequest(req: NextRequest) {
  return {
    deviceToken: req.cookies.get(COOKIE_DEVICE)?.value ?? null,
    sessionToken: req.cookies.get(COOKIE_SESSION)?.value ?? null,
  };
}

/**
 * Для серверных компонентов: состояние входа по cookies текущего запроса.
 *
 * «PIN при каждом запуске»: полная загрузка документа (запуск приложения, перезагрузка, открытие
 * в новой вкладке) на открытой сессии сначала блокирует её, и пользователь видит экран PIN.
 * Мягкие переходы внутри приложения (запросы RSC) блокировку не вызывают. Решение принимается
 * на сервере, а не по sendBeacon при закрытии: маяк может прийти позже запроса новой страницы.
 */
export async function getServerAuth(): Promise<AuthResult> {
  const store = await cookies();
  const h = await headers();
  const deviceToken = store.get(COOKIE_DEVICE)?.value ?? null;
  const sessionToken = store.get(COOKIE_SESSION)?.value ?? null;
  const ctx = { db: getDb() };

  // Рендер страницы не считается активностью пользователя: её отмечают запросы с клиента
  const auth = await getAuthState(ctx, { deviceToken, sessionToken, touch: false });

  // Мягкие переходы Next идут запросами RSC (заголовок rsc). Всё, что просит HTML без него, это
  // загрузка документа. Sec-Fetch-Dest не годится: через service worker он перестаёт быть document.
  const isDocumentLoad = !h.get('rsc') && (h.get('accept') ?? '').includes('text/html');
  if (auth.state === 'ok' && isDocumentLoad && sessionToken) {
    await lockSession(ctx, { sessionToken });
    return { ...auth, state: 'locked', csrf: undefined };
  }
  return auth;
}

export type ApiAuth = AuthResult & { state: 'ok'; userId: string; deviceId: string };

/**
 * Единая проверка для защищённых API: сессия действует, PIN введён, для изменяющих запросов
 * проверены Origin и CSRF-токен. Без сессии ответ 401, на заблокированной по PIN сессии 401 с кодом locked.
 */
export async function requireApiAuth(
  req: NextRequest,
  opts: { mutating: boolean },
): Promise<{ ok: true; auth: ApiAuth } | { ok: false; res: NextResponse }> {
  if (opts.mutating && !isSameOrigin(req)) {
    return { ok: false, res: json({ error: 'Запрос отклонён', code: 'forbidden' }, 403) };
  }
  const { deviceToken, sessionToken } = tokensFromRequest(req);
  const auth = await getAuthState(ctxFromRequest(req), { deviceToken, sessionToken });
  if (auth.state === 'locked') {
    return { ok: false, res: json({ error: 'Введите PIN', code: 'locked' }, 401) };
  }
  if (auth.state !== 'ok' || !auth.userId || !auth.deviceId || !sessionToken) {
    return { ok: false, res: json({ error: 'Требуется вход', code: 'unauthorized' }, 401) };
  }
  if (opts.mutating && !csrfValid(sessionToken, req.headers.get(HEADER_CSRF))) {
    return { ok: false, res: json({ error: 'Запрос отклонён', code: 'forbidden' }, 403) };
  }
  return { ok: true, auth: auth as ApiAuth };
}

/** Ошибка обработчика: наружу общий текст, в лог только имя и сообщение без тел и параметров. */
export function failure(scope: string, e: unknown): NextResponse {
  const name = e instanceof Error ? e.name : 'Error';
  console.error(`[${scope}] ${name}`);
  return json({ error: 'Внутренняя ошибка. Повторите позже' }, 500);
}
