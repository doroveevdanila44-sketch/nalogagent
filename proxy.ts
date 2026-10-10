import { NextResponse, type NextRequest } from 'next/server';

/**
 * Ворота и CSP. Выполняется до рендера.
 *  - Страницы и API кроме /login и /api/auth/* требуют наличия cookie сессии. Это дешёвая первая
 *    проверка. Настоящая (токен, срок, PIN, простой) выполняется в (app)/layout.tsx и в каждом API.
 *  - Без cookie: страницы редиректом на /login, API ответом 401.
 *  - Для страниц выставляется Content-Security-Policy с nonce на каждый запрос.
 * Статика, манифест, иконки и service worker исключены matcher'ом.
 */
const PUBLIC_PAGES = new Set(['/login']);

function csp(nonce: string, hostname: string): string {
  const dev = process.env.NODE_ENV === 'development';
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // React ставит размеры столбцов и полос через атрибут style
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev || local ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (isApi) {
    const open = pathname.startsWith('/api/auth/');
    if (!open && !request.cookies.get('pva_session')) {
      return NextResponse.json(
        { error: 'Требуется вход', code: 'unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.next();
  }

  if (!PUBLIC_PAGES.has(pathname) && !request.cookies.get('pva_session')) {
    // Устройство может быть привязано (cookie pva_device): /login покажет экран PIN
    const url = new URL('/login', request.url);
    if (pathname !== '/' && (pathname === '/agent' || pathname === '/dashboard')) {
      url.searchParams.set('next', pathname);
    }
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = csp(nonce, request.nextUrl.hostname);
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-pathname', pathname);
  headers.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: [
    // Префетчи не исключаются: ворота по cookie должны действовать и на них
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icons/).*)',
  ],
};
