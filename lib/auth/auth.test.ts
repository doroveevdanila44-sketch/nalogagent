import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { createTestDb } from '@/lib/db/testing';
import { devices, sessions } from '@/lib/db/schema';
import { AUTH } from './config';
import {
  changePin,
  createOwner,
  getAuthState,
  lockSession,
  logout,
  passwordLogin,
  revokeDevices,
  setOwnerPassword,
  setupPin,
  verifyPinLogin,
} from './service';

const LOGIN = 'luxautoowner';
const PASSWORD = 'Correct-Horse-9137-Battery';
const T0 = new Date('2026-10-10T00:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

beforeEach(async () => {
  await db.execute(sql`truncate table auth_events, sessions, devices, users restart identity cascade`);
  await createOwner(db, { login: LOGIN, password: PASSWORD });
});

const ctx = (now: Date, ip = '203.0.113.7') => ({ db, now, ip, userAgent: 'vitest' });

async function bindDevice(now = T0, pin = '7391') {
  const login = await passwordLogin(ctx(now), { login: LOGIN, password: PASSWORD });
  if (login.kind !== 'ok') throw new Error('login failed');
  const setup = await setupPin(ctx(now), { deviceToken: login.deviceToken, pin });
  if (setup.kind !== 'ok') throw new Error('setup failed');
  return { deviceToken: login.deviceToken, sessionToken: setup.sessionToken, csrf: setup.csrf };
}

describe('1. вход по паролю', () => {
  it('верный пароль: создаётся устройство и предлагается задать PIN', async () => {
    const r = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    expect(r).toMatchObject({ kind: 'ok', next: 'needPinSetup' });
    const state = await getAuthState(ctx(T0), { deviceToken: (r as { deviceToken: string }).deviceToken });
    expect(state.state).toBe('needPinSetup');
  });

  it('неверный пароль и неверный логин дают один и тот же ответ', async () => {
    const wrongPass = await passwordLogin(ctx(T0), { login: LOGIN, password: 'nope' });
    const wrongLogin = await passwordLogin(ctx(T0), { login: 'someone', password: PASSWORD });
    expect(wrongPass).toEqual({ kind: 'invalid' });
    expect(wrongLogin).toEqual({ kind: 'invalid' });
  });

  it('логин без учёта регистра, пробелы по краям убираются', async () => {
    const r = await passwordLogin(ctx(T0), { login: '  LuxAutoOwner ', password: PASSWORD });
    expect(r.kind).toBe('ok');
  });

  it('пароль чувствителен к регистру', async () => {
    const r = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD.toLowerCase() });
    expect(r.kind).toBe('invalid');
  });
});

describe('2. создание PIN', () => {
  it('все запрещённые PIN отклоняются', async () => {
    const login = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    const token = (login as { deviceToken: string }).deviceToken;
    for (const pin of AUTH.forbiddenPins) {
      expect(await setupPin(ctx(T0), { deviceToken: token, pin })).toEqual({ kind: 'forbidden' });
    }
  });

  it('формат: только 4 цифры', async () => {
    const login = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    const token = (login as { deviceToken: string }).deviceToken;
    for (const pin of ['123', '12345', 'abcd', '12a4', '', ' 123']) {
      expect((await setupPin(ctx(T0), { deviceToken: token, pin })).kind).toBe('invalid');
    }
  });

  it('PIN нельзя задать без входа по паролю или по истечении окна', async () => {
    expect((await setupPin(ctx(T0), { deviceToken: null, pin: '7391' })).kind).toBe('unauthorized');
    const login = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    const token = (login as { deviceToken: string }).deviceToken;
    const late = at(AUTH.pinSetupWindowMinutes + 1);
    expect((await setupPin(ctx(late), { deviceToken: token, pin: '7391' })).kind).toBe('unauthorized');
  });

  it('PIN нельзя перезаписать повторным запросом', async () => {
    const { deviceToken } = await bindDevice();
    expect((await setupPin(ctx(T0), { deviceToken, pin: '2580' })).kind).toBe('unauthorized');
  });

  it('после создания PIN открывается сессия', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    const st = await getAuthState(ctx(T0), { deviceToken, sessionToken });
    expect(st.state).toBe('ok');
    expect(st.login).toBe(LOGIN);
  });
});

describe('повторный вход по PIN', () => {
  it('верный PIN открывает, неверный показывает остаток попыток', async () => {
    const { deviceToken } = await bindDevice();
    const wrong = await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '1357' });
    expect(wrong).toEqual({ kind: 'wrong', attemptsLeft: 4 });
    const ok = await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '7391' });
    expect(ok.kind).toBe('ok');
  });

  it('верный PIN сбрасывает счётчик неверных', async () => {
    const { deviceToken } = await bindDevice();
    await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '1357' });
    await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '1357' });
    expect((await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '7391' })).kind).toBe('ok');
    expect(await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '1357' })).toEqual({ kind: 'wrong', attemptsLeft: 4 });
  });

  it('PIN принадлежит устройству: на другом устройстве он не действует', async () => {
    const a = await bindDevice();
    const login = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    const other = (login as { deviceToken: string }).deviceToken;
    expect(a.deviceToken).not.toBe(other);
    // у второго устройства PIN ещё не задан
    expect((await verifyPinLogin(ctx(T0), { deviceToken: other, pin: '7391' })).kind).toBe('needPinSetup');
  });

  it('вход по паролю на привязанном устройстве не меняет PIN', async () => {
    const { deviceToken } = await bindDevice();
    const r = await passwordLogin(ctx(at(1)), { login: LOGIN, password: PASSWORD, deviceToken });
    expect(r).toMatchObject({ kind: 'ok', next: 'needPin', deviceToken });
    expect((await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '7391' })).kind).toBe('ok');
  });
});

describe('3. блокировка', () => {
  it('пять неверных PIN блокируют PIN, вход по паролю снимает и требует новый', async () => {
    const { deviceToken } = await bindDevice();
    for (let i = 4; i >= 0; i--) {
      const r = await verifyPinLogin(ctx(at(1)), { deviceToken, pin: '1357' });
      if (i > 0) expect(r).toEqual({ kind: 'wrong', attemptsLeft: i });
      else expect(r).toEqual({ kind: 'blocked' });
    }
    // верный PIN после блокировки уже не принимается
    expect((await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '7391' })).kind).toBe('blocked');

    const again = await passwordLogin(ctx(at(3)), { login: LOGIN, password: PASSWORD, deviceToken });
    expect(again).toMatchObject({ kind: 'ok', next: 'needPinSetup' });
    // старый PIN стёрт: при необходимости задаётся заново
    const setup = await setupPin(ctx(at(3)), { deviceToken, pin: '2580' });
    expect(setup.kind).toBe('ok');
    expect((await verifyPinLogin(ctx(at(4)), { deviceToken, pin: '7391' })).kind).toBe('wrong');
    expect((await verifyPinLogin(ctx(at(4)), { deviceToken, pin: '2580' })).kind).toBe('ok');
  });

  it('параллельный перебор не даёт больше пяти попыток', async () => {
    const { deviceToken } = await bindDevice();
    const wrong = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010'];
    const results = await Promise.all(wrong.map((pin) => verifyPinLogin(ctx(at(1)), { deviceToken, pin })));
    const evaluated = results.filter((r) => r.kind === 'wrong').length;
    expect(evaluated).toBeLessThanOrEqual(AUTH.pinFailLimit);
    const [d] = await db.select().from(devices);
    expect(d!.pinFailed).toBeLessThanOrEqual(AUTH.pinFailLimit);
    expect(d!.pinBlocked).toBe(true);
  });

  it('пять неверных паролей: блокировка на 15 минут, затем на час, затем на сутки', async () => {
    const fail = (t: Date) => passwordLogin(ctx(t), { login: LOGIN, password: 'wrong' });

    for (let i = 0; i < 5; i++) expect((await fail(at(i))).kind).toBe('invalid');
    // шестая попытка и верный пароль в окне блокировки получают одинаковый общий ответ
    expect((await fail(at(5))).kind).toBe('throttled');
    expect((await passwordLogin(ctx(at(6)), { login: LOGIN, password: PASSWORD })).kind).toBe('throttled');

    // через 15 минут после блокировки вход снова возможен, но ещё пять ошибок дают час
    const after15 = at(4 + 15 + 1);
    for (let i = 0; i < 5; i++) expect((await fail(new Date(after15.getTime() + i * 1000))).kind).toBe('invalid');
    const insideHour = new Date(after15.getTime() + 30 * 60_000);
    expect((await fail(insideHour)).kind).toBe('throttled');

    // через час доступны ещё пять попыток, после них блокировка на сутки
    const after60 = new Date(after15.getTime() + 4_000 + 60 * 60_000 + 60_000);
    for (let i = 0; i < 5; i++) expect((await fail(new Date(after60.getTime() + i * 1000))).kind).toBe('invalid');
    const insideDay = new Date(after60.getTime() + 23 * 3_600_000);
    expect((await fail(insideDay)).kind).toBe('throttled');
    const afterDay = new Date(after60.getTime() + 25 * 3_600_000);
    expect((await passwordLogin(ctx(afterDay), { login: LOGIN, password: PASSWORD })).kind).toBe('ok');
  });

  it('несуществующий логин блокируется так же, как существующий', async () => {
    const fail = (t: Date) => passwordLogin(ctx(t), { login: 'ghost', password: 'x' });
    for (let i = 0; i < 5; i++) expect((await fail(at(i))).kind).toBe('invalid');
    expect((await fail(at(6))).kind).toBe('throttled');
  });

  it('лимит по IP действует при переборе разных логинов', async () => {
    for (let i = 0; i < AUTH.ipLoginFailLimit; i++) {
      await passwordLogin(ctx(at(0), '198.51.100.9'), { login: `user${i}`, password: 'x' });
    }
    const r = await passwordLogin(ctx(at(1), '198.51.100.9'), { login: LOGIN, password: PASSWORD });
    expect(r.kind).toBe('throttled');
    // с другого адреса вход возможен
    const other = await passwordLogin(ctx(at(1), '198.51.100.10'), { login: LOGIN, password: PASSWORD });
    expect(other.kind).toBe('ok');
  });

  it('успешный вход обнуляет счётчик ошибок', async () => {
    for (let i = 0; i < 4; i++) await passwordLogin(ctx(at(i)), { login: LOGIN, password: 'bad' });
    expect((await passwordLogin(ctx(at(5)), { login: LOGIN, password: PASSWORD })).kind).toBe('ok');
    for (let i = 0; i < 4; i++) expect((await passwordLogin(ctx(at(6 + i)), { login: LOGIN, password: 'bad' })).kind).toBe('invalid');
    expect((await passwordLogin(ctx(at(11)), { login: LOGIN, password: PASSWORD })).kind).toBe('ok');
  });
});

describe('4. простой, блокировка и выход', () => {
  it('после PIN_IDLE_MINUTES без активности сессия блокируется', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    expect((await getAuthState(ctx(at(4)), { deviceToken, sessionToken })).state).toBe('ok');
    // активность в 4 минуты продлила простой: через 4 + 4 всё ещё открыто
    expect((await getAuthState(ctx(at(8)), { deviceToken, sessionToken })).state).toBe('ok');
    // 6 минут тишины
    expect((await getAuthState(ctx(at(14)), { deviceToken, sessionToken })).state).toBe('locked');
    // и остаётся заблокированной даже если «активность» вернулась
    expect((await getAuthState(ctx(at(15)), { deviceToken, sessionToken })).state).toBe('locked');
  });

  it('принудительная блокировка и разблокировка PIN', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    await lockSession(ctx(at(1)), { sessionToken });
    expect((await getAuthState(ctx(at(1)), { deviceToken, sessionToken })).state).toBe('locked');
    const r = await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '7391' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.sessionToken).not.toBe(sessionToken);
      expect((await getAuthState(ctx(at(2)), { deviceToken, sessionToken: r.sessionToken })).state).toBe('ok');
      // старый токен сессии больше не действует
      expect((await getAuthState(ctx(at(2)), { deviceToken, sessionToken })).state).toBe('locked');
    }
  });

  it('сессия живёт 12 часов с момента PIN', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    // поддерживаем активность каждые 4 минуты до 12 часов
    let t = 0;
    while (t < 12 * 60 - 4) {
      t += 4;
      expect((await getAuthState(ctx(at(t)), { deviceToken, sessionToken })).state).toBe('ok');
    }
    t = 12 * 60 + 1;
    expect((await getAuthState(ctx(at(t)), { deviceToken, sessionToken })).state).toBe('locked');
  });

  it('выход удаляет устройство, сессию и PIN', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    await logout(ctx(at(1)), { deviceToken, sessionToken });
    expect((await getAuthState(ctx(at(1)), { deviceToken, sessionToken })).state).toBe('anonymous');
    expect(await db.select().from(devices)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('смена PIN требует текущий PIN', async () => {
    const { deviceToken, sessionToken } = await bindDevice();
    expect((await changePin(ctx(at(1)), { deviceToken, sessionToken, currentPin: '1357', newPin: '2580' })).kind).toBe('wrong');
    expect((await changePin(ctx(at(1)), { deviceToken, sessionToken, currentPin: '7391', newPin: '1111' })).kind).toBe('forbidden');
    expect((await changePin(ctx(at(1)), { deviceToken, sessionToken, currentPin: '7391', newPin: '2580' })).kind).toBe('ok');
    expect((await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '7391' })).kind).toBe('wrong');
    expect((await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '2580' })).kind).toBe('ok');
  });
});

describe('7. сброс', () => {
  it('смена пароля завершает сессии и стирает PIN на всех устройствах', async () => {
    const a = await bindDevice();
    const login = await passwordLogin(ctx(T0), { login: LOGIN, password: PASSWORD });
    const b = (login as { deviceToken: string }).deviceToken;
    await setupPin(ctx(T0), { deviceToken: b, pin: '2580' });

    expect(await setOwnerPassword(db, { login: LOGIN, password: 'brand-new-secret' })).toBe('ok');

    expect(await db.select().from(sessions)).toHaveLength(0);
    for (const d of await db.select().from(devices)) expect(d.pinHash).toBeNull();
    expect((await getAuthState(ctx(at(1)), { deviceToken: a.deviceToken, sessionToken: a.sessionToken })).state).toBe('anonymous');
    // старый пароль не работает, новый работает
    expect((await passwordLogin(ctx(at(2)), { login: LOGIN, password: PASSWORD })).kind).toBe('invalid');
    expect((await passwordLogin(ctx(at(3)), { login: LOGIN, password: 'brand-new-secret' })).kind).toBe('ok');
  });

  it('сброс снимает и блокировку входа', async () => {
    for (let i = 0; i < 5; i++) await passwordLogin(ctx(at(i)), { login: LOGIN, password: 'bad' });
    expect((await passwordLogin(ctx(at(6)), { login: LOGIN, password: PASSWORD })).kind).toBe('throttled');
    await setOwnerPassword(db, { login: LOGIN, password: 'fresh-password-1' });
    expect((await passwordLogin(ctx(at(7)), { login: LOGIN, password: 'fresh-password-1' })).kind).toBe('ok');
  });

  it('revoke-devices удаляет устройства, пароль остаётся', async () => {
    await bindDevice();
    expect(await revokeDevices(db, { login: LOGIN })).toBe('ok');
    expect(await db.select().from(devices)).toHaveLength(0);
    expect((await passwordLogin(ctx(at(1)), { login: LOGIN, password: PASSWORD })).kind).toBe('ok');
  });
});

describe('6. утечки: «ловушка» с заметными PIN и паролем', () => {
  const TRAP_PIN = '8246';
  const TRAP_PASSWORD = 'TrapPassw0rd-Zq7Xk3-leak-check';
  const TRAP_LOGIN_TYPO = 'luxauto-oops-TrapPassw0rd-typed-in-login-field';

  /** Содержимое всей базы одним текстом, UUID и метки времени вынуты: они случайны и дают ложные совпадения. */
  async function dumpDatabase(): Promise<string> {
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    const rows = (tables as unknown as { rows: { table_name: string }[] }).rows;
    const chunks: string[] = [];
    for (const { table_name } of rows) {
      const data = await db.execute(sql.raw(`select * from "${table_name}"`));
      chunks.push(`# ${table_name}\n${JSON.stringify((data as unknown as { rows: unknown[] }).rows)}`);
    }
    return chunks
      .join('\n')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TS');
  }

  it('нигде нет открытого пароля и PIN', async () => {
    await setOwnerPassword(db, { login: LOGIN, password: TRAP_PASSWORD });
    // опечатка: пароль введён в поле логина
    await passwordLogin(ctx(at(0)), { login: TRAP_LOGIN_TYPO, password: 'x' });
    await passwordLogin(ctx(at(0)), { login: LOGIN, password: `${TRAP_PASSWORD}-wrong` });
    const login = await passwordLogin(ctx(at(1)), { login: LOGIN, password: TRAP_PASSWORD });
    const deviceToken = (login as { deviceToken: string }).deviceToken;
    const setup = await setupPin(ctx(at(1)), { deviceToken, pin: TRAP_PIN });
    expect(setup.kind).toBe('ok');
    await verifyPinLogin(ctx(at(2)), { deviceToken, pin: '1357' });
    await verifyPinLogin(ctx(at(2)), { deviceToken, pin: TRAP_PIN });
    await changePin(ctx(at(3)), {
      deviceToken,
      sessionToken: (setup as { sessionToken: string }).sessionToken,
      currentPin: TRAP_PIN,
      newPin: '5173',
    });

    const dump = await dumpDatabase();
    expect(dump).not.toContain(TRAP_PASSWORD);
    expect(dump).not.toContain('TrapPassw0rd');
    expect(new RegExp(`(?<!\\d)${TRAP_PIN}(?!\\d)`).test(dump)).toBe(false);
    expect(new RegExp('(?<!\\d)5173(?!\\d)').test(dump)).toBe(false);
    // хэши на месте и не равны открытым значениям
    expect(dump).toContain('$argon2id$');
    // токены в базе только как SHA-256 (64 hex), а не открытые
    const token = deviceToken;
    expect(dump).not.toContain(token);
  });
});
