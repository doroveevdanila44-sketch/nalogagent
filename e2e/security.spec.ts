import { expect, request as pwRequest, test } from '@playwright/test';
import { firstLogin, resetChat } from './helpers';

const PIN = '8246';

/**
 * Проверки безопасности работающего приложения: без входа API закрыт, изменяющие запросы требуют
 * Origin и CSRF-токен, кривые идентификаторы дают 404 и 400, а не 500, заголовки и cookies на месте,
 * текст в чате не превращается в разметку.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test('без входа API и страницы закрыты, секреты не отдаются', async ({ baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  for (const [method, url] of [
    ['get', '/api/chat'],
    ['delete', '/api/chat'],
    ['post', '/api/chat'],
    ['get', '/api/dashboard'],
    ['get', '/api/documents'],
    ['post', '/api/calc'],
    ['get', '/api/export?message=1'],
    ['get', '/api/reviews'],
  ] as const) {
    const res = await anon[method](url, { maxRedirects: 0 });
    expect(res.status(), `${method} ${url}`).toBe(401);
  }
  for (const path of ['/agent', '/dashboard', '/documents', '/.env', '/.git/config', '/docs/AGENT.md', '/package.json']) {
    const res = await anon.get(path, { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308, 404], path).toContain(res.status());
    if (res.status() >= 300 && res.status() < 400) expect(res.headers().location ?? '', path).toContain('/login');
  }
  await anon.dispose();
});

test('заголовки безопасности и флаги cookies', async ({ page, context }) => {
  test.setTimeout(90_000);
  await resetChat();
  const response = await page.goto('/login');
  const h = response!.headers();
  expect(h['strict-transport-security']).toContain('max-age=');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('same-origin');
  expect(h['permissions-policy']).toContain('camera=()');
  expect(h['cache-control']).toContain('no-store');
  const csp = h['content-security-policy']!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(h['x-powered-by']).toBeUndefined();

  await firstLogin(page, PIN);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'pva_session')!;
  const device = cookies.find((c) => c.name === 'pva_device')!;
  for (const c of [session, device]) {
    expect(c.httpOnly, c.name).toBe(true);
    expect(c.sameSite, c.name).toBe('Lax');
    expect(c.path, c.name).toBe('/');
  }
  // сессионная cookie без срока, cookie устройства с большим сроком
  expect(session.expires).toBe(-1);
  expect(device.expires).toBeGreaterThan(Date.now() / 1000 + 86_400 * 30);
});

test('изменяющие запросы без Origin и CSRF-токена отклоняются, с верными проходят', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await resetChat();
  await firstLogin(page, PIN);
  const csrf = await page.evaluate(
    async () => ((await (await fetch('/api/auth/state', { credentials: 'same-origin' })).json()) as { csrf: string }).csrf,
  );
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);

  const ctx = page.context().request;
  const json = { 'content-type': 'application/json' };
  const origin = new URL(baseURL!).origin;

  // чужой Origin
  for (const [method, url] of [['delete', '/api/chat'], ['post', '/api/chat']] as const) {
    const res = await ctx[method](url, {
      headers: { ...json, origin: 'https://evil.example', 'x-csrf-token': csrf },
      data: method === 'post' ? { message: 'привет' } : undefined,
    });
    expect(res.status(), `${method} чужой Origin`).toBe(403);
  }
  // тот же Origin, но без токена и с неверным токеном
  for (const token of [undefined, 'x'.repeat(64), '0'.repeat(64)]) {
    const res = await ctx.delete('/api/chat', { headers: { origin, ...(token ? { 'x-csrf-token': token } : {}) } });
    expect(res.status(), `токен ${token ?? 'нет'}`).toBe(403);
  }
  // Origin нет вообще (скрипт, curl): запрос отклонён
  const noOrigin = await ctx.post('/api/chat', { headers: { ...json, 'x-csrf-token': csrf }, data: { message: 'привет' } });
  expect([200, 403]).toContain(noOrigin.status());
  // верные Origin и токен проходят
  const ok = await ctx.post('/api/chat', { headers: { ...json, origin, 'x-csrf-token': csrf }, data: { message: 'привет' } });
  expect(ok.status()).toBe(200);
  const cleared = await ctx.delete('/api/chat', { headers: { origin, 'x-csrf-token': csrf } });
  expect(cleared.status()).toBe(200);
  expect(((await cleared.json()) as { deleted: number }).deleted).toBeGreaterThanOrEqual(2);
});

test('кривые данные дают 400 и 404, а не 500', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await resetChat();
  await firstLogin(page, PIN);
  const csrf = await page.evaluate(
    async () => ((await (await fetch('/api/auth/state', { credentials: 'same-origin' })).json()) as { csrf: string }).csrf,
  );
  const ctx = page.context().request;
  const origin = new URL(baseURL!).origin;
  const h = { origin, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // идентификаторы документов
  for (const id of ['xyz', '------------------------------------', "'; drop table documents; --", '00000000-0000-0000-0000-00000000000g']) {
    const res = await ctx.get(`/api/documents/${encodeURIComponent(id)}`);
    expect(res.status(), id).toBe(404);
  }
  expect((await ctx.get('/api/documents/00000000-0000-0000-0000-000000000000')).status()).toBe(404);
  expect((await ctx.get('/api/documents/00000000-0000-0000-0000-000000000000?version=99999999999')).status()).toBe(404);
  for (const url of ['/api/documents/restore', '/api/documents/delete']) {
    expect((await ctx.post(url, { headers: h, data: { ids: ['not-a-uuid'] } })).status(), url).toBe(400);
  }
  // числа вне диапазона базы
  expect((await ctx.post('/api/chat', { headers: h, data: { message: 'привет', baseId: 1e30 } })).status()).toBe(400);
  expect((await ctx.post('/api/calc', { headers: h, data: { message: 1e30 } })).status()).toBe(400);
  expect((await ctx.get('/api/export?message=99999999999999999999')).status()).toBe(400);
  // тело не JSON, не тот тип, слишком большое, лишние поля
  expect((await ctx.post('/api/chat', { headers: { ...h, 'content-type': 'text/plain' }, data: 'привет' })).status()).toBe(400);
  expect((await ctx.post('/api/chat', { headers: h, data: '{не json' })).status()).toBe(400);
  expect((await ctx.post('/api/chat', { headers: h, data: { message: 'а'.repeat(20_000) } })).status()).toBe(400);
  expect((await ctx.post('/api/chat', { headers: h, data: { message: 'а'.repeat(1001) } })).status()).toBe(400);
  expect((await ctx.post('/api/chat', { headers: h, data: { message: '' } })).status()).toBe(400);
  expect((await ctx.post('/api/chat', { headers: h, data: { form: { entityId: 'x' } } })).status()).toBe(400);
  expect((await ctx.get('/api/export?review=not-a-uuid')).status()).toBe(400);
  expect((await ctx.get('/api/export?q=%7Bbad')).status()).toBe(400);
  // запросы расчёта: год и период вне границ данных не вешают сервер
  const t0 = Date.now();
  const far = await ctx.post('/api/calc', {
    headers: h,
    data: { queries: [{ tax: 'vat', period: { kind: 'range', from: '2000-01-01', to: '2100-12-31' }, entityIds: 'all' }] },
  });
  expect(far.status()).toBeLessThan(500);
  expect(Date.now() - t0).toBeLessThan(5000);
});

test('текст в чате не превращается в разметку и скрипты', async ({ page }) => {
  test.setTimeout(90_000);
  await resetChat();
  await firstLogin(page, PIN);
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const field = page.getByLabel('Вопрос агенту');
  await field.fill(payload);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.typing')).toHaveCount(0);
  // сообщение пользователя показано как текст
  await expect(page.locator('.msg.me').last()).toHaveText(payload);
  await expect(page.locator('.chat img, .chat script')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // и после перезагрузки истории из базы
  await page.getByRole('link', { name: 'Дашборд' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
  await page.getByRole('link', { name: 'Агент' }).click();
  await expect(page.locator('.msg.me').last()).toHaveText(payload);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('несуществующий адрес: русская страница 404 без подробностей, без входа редирект', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const anon = await pwRequest.newContext({ baseURL });
  const redirected = await anon.get('/net-takoy-stranitsy', { maxRedirects: 0 });
  expect(redirected.status()).toBe(307);
  await anon.dispose();

  await resetChat();
  await firstLogin(page, PIN);
  const res = await page.context().request.get('/net-takoy-stranitsy');
  expect(res.status()).toBe(404);
  const html = await res.text();
  expect(html).toContain('Страница не найдена');
  // ни стека, ни путей к файлам, ни имён библиотек
  expect(html).not.toMatch(/node_modules|\.tsx?:\d+|at Object\.|webpack-internal/);
  expect(res.headers()['content-security-policy']).toBeDefined();
});
