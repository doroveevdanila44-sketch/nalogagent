import './_env';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '@/lib/db/client';

async function main() {
  const db = getDb() as unknown as Parameters<typeof migrate>[0];
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  console.log('Миграции применены');
}

main()
  .catch((e) => {
    console.error('Ошибка миграции:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
