import { ApiError, LOCKED_EVENT, api } from '@/lib/client/api';
import type { CalcQuery } from '@/lib/provenance/query';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';

/** Что считать: запросы расчёта на момент `at` или сохранённый ответ чата. */
export type TargetBody = { queries: CalcQuery[]; at: number } | { message: number };

const cache = new Map<string, Promise<CalcSnapshot[]>>();
const CACHE_LIMIT = 8;

const keyOf = (t: TargetBody) => JSON.stringify(t);

/**
 * Снимки расчёта по цели. Панель, проверка и передача открываются одна над другой по одной и той
 * же цели, поэтому запрос выполняется один раз; при ошибке запись из кэша убирается.
 */
export function fetchSnapshots(target: TargetBody): Promise<CalcSnapshot[]> {
  const key = keyOf(target);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = api<{ items: CalcSnapshot[] }>('/api/calc', { body: target }).then((r) => r.items);
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return p;
}

/** Имя файла из Content-Disposition: filename*=UTF-8''... */
function fileNameOf(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // падаем на обычное имя
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? null;
}

/** Скачивает файл по адресу маршрута выгрузки. Ошибки приходят как ApiError. */
export async function downloadFile(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('Нет связи с сервером', 0, 'network');
  }
  if (!res.ok) {
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // тело не JSON
    }
    const code = typeof data.code === 'string' ? data.code : 'error';
    if (res.status === 401 && code === 'locked') window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
    if (res.status === 401 && code === 'unauthorized') window.location.assign('/login');
    throw new ApiError(typeof data.error === 'string' ? data.error : 'Ошибка запроса', res.status, code, data);
  }
  const blob = await res.blob();
  const name = fileNameOf(res.headers.get('Content-Disposition')) ?? 'Расчёт.xlsx';
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 15_000);
  return name;
}

export function exportUrl(target: TargetBody): string {
  return 'message' in target
    ? `/api/export?message=${target.message}`
    : `/api/export?q=${encodeURIComponent(JSON.stringify(target))}`;
}

export function downloadExcel(target: TargetBody): Promise<string> {
  return downloadFile(exportUrl(target));
}

/** Сообщение для пользователя по ошибке запроса. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.code === 'network') return 'Нет связи с сервером';
    if (e.code === 'locked') return 'Введите PIN';
    if (e.code === 'target') return e.message;
  }
  return fallback;
}
