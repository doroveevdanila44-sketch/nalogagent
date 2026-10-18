import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Защита от CSRF: выбран ОДИН механизм для запросов, меняющих состояние.
 *   1. Заголовок Origin (или Sec-Fetch-Site) обязан указывать на тот же хост.
 *   2. Для запросов с сессией дополнительно требуется токен в X-CSRF-Token (HMAC от токена сессии).
 * Cookies при этом остаются SameSite=Lax, как требует AUTH.md; SameSite=Strict не используется,
 * иначе переход по внешней ссылке терял бы сессию.
 */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

export function clientIp(headers: Headers): string | null {
  const candidate = headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return candidate && isIP(candidate) ? candidate : null;
}

export class BodyError extends Error {}

/**
 * Символ NUL (U+0000) Postgres в текст не принимает: запись падала бы ошибкой базы, то есть 500. Он
 * бывает в тексте, вставленном из чужих программ, и в запросах, собранных вручную. Строка с ним
 * отклоняется ещё при разборе тела.
 */
export function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k.includes('\u0000') || containsNul(v));
  }
  return false;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Читает тело как JSON и проверяет схемой. Ошибка валидации не содержит значений полей:
 * в сообщении только факт, чтобы пароль или PIN не попали в лог через текст ошибки.
 */
export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) throw new BodyError('content-type');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new BodyError('size');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BodyError('json');
  }
  if (containsNul(raw)) throw new BodyError('nul');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BodyError('shape');
  return parsed.data;
}
