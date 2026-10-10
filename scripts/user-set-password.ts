import './_env';
import { askPasswordTwice } from './_prompt';
import { setOwnerPassword } from '@/lib/auth/service';
import { closeDb, getDb } from '@/lib/db/client';

const OWNER_LOGIN = 'luxautoowner';

async function main() {
  const password = await askPasswordTwice();
  if (!password) {
    process.exitCode = 1;
    return;
  }
  const result = await setOwnerPassword(getDb(), { login: OWNER_LOGIN, password });
  if (result === 'notFound') {
    console.error('Пользователь не найден. Сначала: npm run user:create');
    process.exitCode = 1;
    return;
  }
  console.log('пароль изменён, сессии завершены, PIN на всех устройствах стёрт');
}

main()
  .catch((e) => {
    console.error('Ошибка:', e instanceof Error ? e.name : 'неизвестная ошибка');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
