/**
 * Запись ошибки границы (error.tsx, global-error.tsx) в консоль: имя, сообщение и digest. По digest
 * ошибку находят в журнале сервера (Vercel): Next пишет туда полный текст серверной ошибки с тем же
 * digest, а в браузер отдаёт только его. Стек и данные не выводятся, пользователю текст не меняется.
 */
export function logBoundaryError(scope: string, error: Error & { digest?: string }): void {
  console.error(`[${scope}] ${error.name}: ${error.message}`, { digest: error.digest ?? null });
}
