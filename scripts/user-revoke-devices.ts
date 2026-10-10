import './_env';
import { revokeDevices } from '@/lib/auth/service';
import { closeDb, getDb } from '@/lib/db/client';

const OWNER_LOGIN = 'luxautoowner';

async function main() {
  const result = await revokeDevices(getDb(), { login: OWNER_LOGIN });
  if (result === 'notFound') {
    console.error('Пользователь не найден');
    process.exitCode = 1;
    return;
  }
  console.log('устройства и сессии удалены, пароль не менялся');
}

main()
  .catch((e) => {
    console.error('Ошибка:', e instanceof Error ? e.name : 'неизвестная ошибка');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
