import './_env';
import { closeDb, getDb } from '@/lib/db/client';
import { seedDatabase } from '@/lib/db/seed';
import { getEnv } from '@/lib/env';
import { momentFromEpoch } from '@/lib/calc/time';

async function main() {
  const now = momentFromEpoch(Date.now(), getEnv().appTz);
  await seedDatabase(getDb(), { year: now.year, month: now.month + 1 });
  console.log(`Сид выполнен (год ${now.year}, месяц ${now.month + 1})`);
}

main()
  .catch((e) => {
    console.error('Ошибка сида:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
