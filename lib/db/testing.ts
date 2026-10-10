import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from './client';
import * as schema from './schema';

/**
 * Свежая база в памяти для тестов: настоящий Postgres (WASM) и те же миграции, что на Neon.
 * Только для тестов, в рабочий код не импортируется.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  return { db: db as unknown as Db, close: () => client.close() };
}
