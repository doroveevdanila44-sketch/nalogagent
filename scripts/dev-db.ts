import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Локальный Postgres для разработки без Docker. Настоящий сервер PostgreSQL, не эмуляция.
 * Данные в .data/pg. Остановка: Ctrl+C.
 */
const dir = path.resolve(process.cwd(), '.data/pg');
const port = Number(process.env.DEV_DB_PORT ?? 54329);

async function main() {
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
  });

  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    await server.initialise();
  }
  await server.start();
  try {
    await server.createDatabase('pva');
  } catch {
    // база уже есть
  }
  console.log(`Postgres запущен: postgres://postgres:postgres@127.0.0.1:${port}/pva`);
  console.log('Остановка: Ctrl+C');

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => undefined, 1 << 30);
}

main().catch((e) => {
  console.error('Не удалось запустить локальную базу:', e instanceof Error ? e.message : e);
  process.exit(1);
});
