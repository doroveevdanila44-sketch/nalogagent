import './_env';
import { closeDb, getDb } from '@/lib/db/client';
import { seedDatabase } from '@/lib/db/seed';
import { getEnv } from '@/lib/env';

async function main() {
  await seedDatabase(getDb(), { tz: getEnv().appTz });
  console.log('Сид выполнен: демо-источник «Выгрузка из 1С (демо)», выручка за 2025 и 2026 годы');
}

main()
  .catch((e) => {
    console.error('Ошибка сида:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
