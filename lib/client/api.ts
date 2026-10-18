/**
 * Клиентский доступ к API. Токен CSRF хранится только в памяти страницы (не в localStorage).
 * Пароль и PIN передаются только в теле POST, не в URL.
 */
let csrf = '';

export function setCsrf(token: string): void {
  csrf = token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const LOCKED_EVENT = 'pva:locked';
/** Экран PIN снят: страницы перечитывают данные, обучение повторяет подготовку шага */
export const UNLOCKED_EVENT = 'pva:unlocked';

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Нет связи с сервером', 0, 'network');
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // пустое тело
  }

  if (!res.ok) {
    const code = typeof data.code === 'string' ? data.code : 'error';
    if (res.status === 401 && code === 'locked' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
    }
    if (res.status === 401 && code === 'unauthorized' && typeof window !== 'undefined') {
      window.location.assign('/login');
    }
    throw new ApiError(typeof data.error === 'string' ? data.error : 'Ошибка запроса', res.status, code, data);
  }
  return data as T;
}
