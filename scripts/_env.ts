import fs from 'node:fs';

/** Скрипты не проходят через Next, поэтому .env.local читаем сами. Переменные оболочки главнее. */
for (const file of ['.env.local', '.env']) {
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // файл с ошибкой формата не должен ронять скрипт
    }
  }
}
