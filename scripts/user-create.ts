import './_env';
import { askPasswordTwice } from './_prompt';
import { createOwner } from '@/lib/auth/service';
import { closeDb, getDb } from '@/lib/db/client';

const OWNER_LOGIN = 'luxautoowner';

async function main() {
  const password = await askPasswordTwice();
  if (!password) {
    process.exitCode = 1;
    return;
  }
  const result = await createOwner(getDb(), { login: OWNER_LOGIN, password });
  if (result === 'exists') {
    console.error('Пользователь уже существует. Чтобы сменить пароль: npm run user:set-password');
    process.exitCode = 1;
    return;
  }
  console.log('создан');
}

main()
  .catch((e) => {
    console.error('Ошибка:', e instanceof Error ? e.name : 'неизвестная ошибка');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
