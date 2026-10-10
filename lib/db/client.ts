import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool, type PoolConfig } from 'pg';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

/** Тип базы общий для node-postgres (рабочий) и PGlite (тесты). */
export type Db = PgDatabase<any, typeof schema>;

const g = globalThis as unknown as { __pvaPool?: Pool; __pvaDb?: Db };

function sslFor(connectionString: string, ca: string | null): PoolConfig['ssl'] {
  const url = new URL(connectionString);
  const mode = url.searchParams.get('sslmode');
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (mode === 'disable' || (local && !mode && !ca)) return undefined;
  if (ca) return { ca, rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

/**
 * Один пул на процесс. Строка подключения и сертификат только из окружения,
 * поэтому переезд с Neon на Yandex Managed PostgreSQL это смена переменных.
 */
export function getDb(): Db {
  if (g.__pvaDb) return g.__pvaDb;
  const env = getEnv();
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL не задан. Локально: npm run db:dev и строка из .env.example.');
  }
  // sslmode убираем из строки: параметры SSL задаём явно ниже
  const cleaned = new URL(env.databaseUrl);
  const ssl = sslFor(env.databaseUrl, env.databaseSslCa);
  cleaned.searchParams.delete('sslmode');
  const pool = new Pool({
    connectionString: cleaned.toString(),
    ssl,
    max: env.isProd ? 5 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // Текст ошибки пула не содержит параметров запросов
    console.error('[db] ошибка пула соединений:', err.message);
  });
  g.__pvaPool = pool;
  g.__pvaDb = drizzle(pool, { schema }) as unknown as Db;
  return g.__pvaDb;
}

export async function closeDb(): Promise<void> {
  if (g.__pvaPool) {
    await g.__pvaPool.end();
    g.__pvaPool = undefined;
    g.__pvaDb = undefined;
  }
}

export { schema };
