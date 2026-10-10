import { and, count, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { authEvents, devices, sessions, users } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { AUTH } from './config';
import { hmacHex, randomToken, safeEqual, sha256Hex } from './crypto';
import { dummyPasswordHash, hashPassword, hashPin, verifyPassword, verifyPin } from './hash';

/**
 * Вся логика входа без привязки к Next: принимает базу, часы и токены из cookie, возвращает результат.
 * Cookie расставляют обработчики маршрутов (lib/auth/server.ts). Ни пароль, ни PIN, ни их хэши
 * не попадают в логи, события и ответы.
 */
export interface Ctx {
  db: Db;
  now?: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export type AuthState = 'anonymous' | 'needPinSetup' | 'locked' | 'ok';

const minutes = (n: number) => n * 60_000;

export function normalizeLogin(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Ключ логина в журнале: HMAC, чтобы не хранить введённый текст (в поле логина могут ввести пароль). */
function loginKey(login: string): string {
  return `h:${hmacHex(getEnv().sessionSecret, `login:${login}`).slice(0, 32)}`;
}

export function csrfFor(sessionTokenHash: string): string {
  return hmacHex(getEnv().sessionSecret, `csrf:${sessionTokenHash}`);
}

export function csrfValid(sessionToken: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  return safeEqual(csrfFor(sha256Hex(sessionToken)), presented);
}

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

export function isForbiddenPin(pin: string): boolean {
  return (AUTH.forbiddenPins as readonly string[]).includes(pin);
}

async function record(
  ctx: Ctx,
  kind: string,
  extra: { userId?: string | null; deviceId?: string | null; loginKey?: string | null } = {},
) {
  await ctx.db.insert(authEvents).values({
    at: ctx.now ?? new Date(),
    kind,
    userId: extra.userId ?? null,
    deviceId: extra.deviceId ?? null,
    ip: ctx.ip ?? null,
    loginTried: extra.loginKey ?? null,
  });
}

// ===== Лимиты =====

interface LoginGate {
  blocked: boolean;
  retryAfterSec: number;
}

/** Блокировка входа по логину и IP. Считается из auth_events, не из памяти процесса. */
async function loginGate(ctx: Ctx, key: string): Promise<LoginGate> {
  const now = ctx.now ?? new Date();

  if (ctx.ip) {
    const since = new Date(now.getTime() - minutes(AUTH.ipWindowMinutes));
    const [row] = await ctx.db
      .select({ n: count() })
      .from(authEvents)
      .where(and(eq(authEvents.kind, 'login_fail'), eq(authEvents.ip, ctx.ip), gt(authEvents.at, since)));
    if ((row?.n ?? 0) >= AUTH.ipLoginFailLimit) {
      return { blocked: true, retryAfterSec: AUTH.ipWindowMinutes * 60 };
    }
  }

  const state = await loginLockState(ctx, key);
  if (state.lockedUntil && state.lockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

async function loginLockState(ctx: Ctx, key: string) {
  const { db } = ctx;
  // Граница: последний успешный вход этого логина или сброс владельцем (сброс общий)
  const [boundaryRow] = await db
    .select({ at: authEvents.at })
    .from(authEvents)
    .where(
      or(
        and(eq(authEvents.kind, 'login_ok'), eq(authEvents.loginTried, key)),
        eq(authEvents.kind, 'reset'),
      ),
    )
    .orderBy(desc(authEvents.at))
    .limit(1);
  const boundary = boundaryRow?.at ?? new Date(0);

  const locks = await db
    .select({ at: authEvents.at })
    .from(authEvents)
    .where(and(eq(authEvents.kind, 'login_lock'), eq(authEvents.loginTried, key), gt(authEvents.at, boundary)))
    .orderBy(authEvents.at);

  const lastLock = locks.at(-1)?.at ?? null;
  const level = locks.length;
  let lockedUntil: Date | null = null;
  if (lastLock) {
    const steps = AUTH.loginLockMinutes;
    const duration = steps[Math.min(level - 1, steps.length - 1)]!;
    lockedUntil = new Date(lastLock.getTime() + minutes(duration));
  }

  const failsFrom = lastLock && lastLock > boundary ? lastLock : boundary;
  const [fails] = await db
    .select({ n: count() })
    .from(authEvents)
    .where(and(eq(authEvents.kind, 'login_fail'), eq(authEvents.loginTried, key), gt(authEvents.at, failsFrom)));

  return { lockedUntil, level, failsSinceLock: fails?.n ?? 0 };
}

// ===== Вход по паролю =====

export type PasswordLoginResult =
  | { kind: 'ok'; next: 'needPinSetup' | 'needPin'; deviceToken: string }
  | { kind: 'invalid' }
  | { kind: 'throttled'; retryAfterSec: number };

export async function passwordLogin(
  ctx: Ctx,
  input: { login: string; password: string; deviceToken?: string | null },
): Promise<PasswordLoginResult> {
  const { db } = ctx;
  const now = ctx.now ?? new Date();
  const login = normalizeLogin(input.login);
  const key = loginKey(login);

  const gate = await loginGate(ctx, key);
  if (gate.blocked) return { kind: 'throttled', retryAfterSec: gate.retryAfterSec };

  const [user] = await db.select().from(users).where(eq(users.login, login)).limit(1);
  // Для несуществующего логина считаем хэш впустую: время ответа не выдаёт, есть ли такой логин
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), input.password);

  if (!user || !passwordOk) {
    await record(ctx, 'login_fail', { userId: user?.id ?? null, loginKey: key });
    const st = await loginLockState(ctx, key);
    if (st.failsSinceLock >= AUTH.loginFailLimit) {
      await record(ctx, 'login_lock', { userId: user?.id ?? null, loginKey: key });
    }
    return { kind: 'invalid' };
  }

  await record(ctx, 'login_ok', { userId: user.id, loginKey: key });

  let device = input.deviceToken ? await findDevice(db, input.deviceToken) : null;
  if (device && device.userId !== user.id) device = null;

  if (!device) {
    const token = randomToken();
    await db.insert(devices).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      userAgent: ctx.userAgent?.slice(0, 256) ?? null,
      passwordVerifiedAt: now,
      createdAt: now,
      lastSeenAt: now,
    });
    return { kind: 'ok', next: 'needPinSetup', deviceToken: token };
  }

  const needsReset = device.pinBlocked || !device.pinHash;
  await db
    .update(devices)
    .set({
      passwordVerifiedAt: now,
      lastSeenAt: now,
      userAgent: ctx.userAgent?.slice(0, 256) ?? device.userAgent,
      ...(needsReset ? { pinHash: null, pinFailed: 0, pinBlocked: false } : {}),
    })
    .where(eq(devices.id, device.id));
  if (needsReset) await db.delete(sessions).where(eq(sessions.deviceId, device.id));

  return {
    kind: 'ok',
    next: needsReset ? 'needPinSetup' : 'needPin',
    deviceToken: input.deviceToken!,
  };
}

export async function findDevice(db: Db, token: string) {
  const [d] = await db.select().from(devices).where(eq(devices.tokenHash, sha256Hex(token))).limit(1);
  return d ?? null;
}

// ===== Сессии =====

async function createSession(ctx: Ctx, userId: string, deviceId: string) {
  const now = ctx.now ?? new Date();
  await ctx.db.delete(sessions).where(eq(sessions.deviceId, deviceId));
  const token = randomToken();
  const tokenHash = sha256Hex(token);
  await ctx.db.insert(sessions).values({
    userId,
    deviceId,
    tokenHash,
    createdAt: now,
    lastActivity: now,
    expiresAt: new Date(now.getTime() + AUTH.sessionHours * 3_600_000),
  });
  return { token, csrf: csrfFor(tokenHash) };
}

// ===== PIN =====

export type SetupPinResult =
  | { kind: 'ok'; sessionToken: string; csrf: string }
  | { kind: 'invalid' }
  | { kind: 'forbidden' }
  | { kind: 'unauthorized' };

export async function setupPin(ctx: Ctx, input: { deviceToken: string | null; pin: string }): Promise<SetupPinResult> {
  const { db } = ctx;
  const now = ctx.now ?? new Date();
  if (!isValidPinFormat(input.pin)) return { kind: 'invalid' };
  if (isForbiddenPin(input.pin)) return { kind: 'forbidden' };
  if (!input.deviceToken) return { kind: 'unauthorized' };

  const device = await findDevice(db, input.deviceToken);
  if (!device || device.pinHash) return { kind: 'unauthorized' };
  const verifiedAt = device.passwordVerifiedAt;
  if (!verifiedAt || now.getTime() - verifiedAt.getTime() > minutes(AUTH.pinSetupWindowMinutes)) {
    return { kind: 'unauthorized' };
  }

  const pinHash = await hashPin(device.userId, device.id, input.pin);
  // Условие pin_hash IS NULL: два параллельных запроса не перезапишут друг друга
  const updated = await db
    .update(devices)
    .set({ pinHash, pinFailed: 0, pinBlocked: false, lastSeenAt: now })
    .where(and(eq(devices.id, device.id), isNull(devices.pinHash)))
    .returning({ id: devices.id });
  if (updated.length === 0) return { kind: 'unauthorized' };

  const session = await createSession(ctx, device.userId, device.id);
  await record(ctx, 'pin_setup', { userId: device.userId, deviceId: device.id });
  return { kind: 'ok', sessionToken: session.token, csrf: session.csrf };
}

type PinAttempt =
  | { ok: true }
  | { ok: false; reason: 'blocked' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number; blocked: boolean };

/**
 * Попытка PIN. Счётчик увеличивается до проверки одним атомарным UPDATE: параллельные запросы
 * не позволяют перебрать больше pinFailLimit вариантов.
 */
async function attemptPin(ctx: Ctx, device: typeof devices.$inferSelect, pin: string): Promise<PinAttempt> {
  const { db } = ctx;
  const now = ctx.now ?? new Date();

  if (ctx.ip) {
    const since = new Date(now.getTime() - minutes(AUTH.ipWindowMinutes));
    const [row] = await db
      .select({ n: count() })
      .from(authEvents)
      .where(and(eq(authEvents.kind, 'pin_fail'), eq(authEvents.ip, ctx.ip), gt(authEvents.at, since)));
    if ((row?.n ?? 0) >= AUTH.ipPinFailLimit) return { ok: false, reason: 'blocked' };
  }

  const reserved = await db
    .update(devices)
    .set({
      pinFailed: sql`${devices.pinFailed} + 1`,
      pinBlocked: sql`(${devices.pinFailed} + 1) >= ${AUTH.pinFailLimit}`,
    })
    .where(and(eq(devices.id, device.id), eq(devices.pinBlocked, false), isNotNull(devices.pinHash)))
    .returning({ pinFailed: devices.pinFailed, pinBlocked: devices.pinBlocked, pinHash: devices.pinHash });
  const row = reserved[0];
  if (!row || !row.pinHash) return { ok: false, reason: 'blocked' };

  const match = await verifyPin(row.pinHash, device.userId, device.id, pin);
  if (match) {
    await db
      .update(devices)
      .set({ pinFailed: 0, pinBlocked: false, lastSeenAt: now })
      .where(eq(devices.id, device.id));
    return { ok: true };
  }

  await record(ctx, 'pin_fail', { userId: device.userId, deviceId: device.id });
  if (row.pinBlocked) {
    await db.delete(sessions).where(eq(sessions.deviceId, device.id));
  }
  return {
    ok: false,
    reason: 'wrong',
    attemptsLeft: Math.max(0, AUTH.pinFailLimit - row.pinFailed),
    blocked: row.pinBlocked,
  };
}

export type VerifyPinResult =
  | { kind: 'ok'; sessionToken: string; csrf: string }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'blocked' }
  | { kind: 'needPinSetup' }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' };

export async function verifyPinLogin(
  ctx: Ctx,
  input: { deviceToken: string | null; pin: string },
): Promise<VerifyPinResult> {
  if (!isValidPinFormat(input.pin)) return { kind: 'invalid' };
  if (!input.deviceToken) return { kind: 'unauthorized' };
  const device = await findDevice(ctx.db, input.deviceToken);
  if (!device) return { kind: 'unauthorized' };
  if (!device.pinHash) return { kind: 'needPinSetup' };
  if (device.pinBlocked) return { kind: 'blocked' };

  const res = await attemptPin(ctx, device, input.pin);
  if (res.ok) {
    const session = await createSession(ctx, device.userId, device.id);
    await record(ctx, 'pin_ok', { userId: device.userId, deviceId: device.id });
    return { kind: 'ok', sessionToken: session.token, csrf: session.csrf };
  }
  if (res.reason === 'blocked' || res.blocked) return { kind: 'blocked' };
  return { kind: 'wrong', attemptsLeft: res.attemptsLeft };
}

export type ChangePinResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'blocked' }
  | { kind: 'forbidden' }
  | { kind: 'invalid' }
  | { kind: 'unauthorized' };

export async function changePin(
  ctx: Ctx,
  input: { deviceToken: string | null; sessionToken: string | null; currentPin: string; newPin: string },
): Promise<ChangePinResult> {
  if (!isValidPinFormat(input.currentPin) || !isValidPinFormat(input.newPin)) return { kind: 'invalid' };
  if (isForbiddenPin(input.newPin)) return { kind: 'forbidden' };
  const auth = await getAuthState(ctx, { deviceToken: input.deviceToken, sessionToken: input.sessionToken });
  if (auth.state !== 'ok') return { kind: 'unauthorized' };
  const device = await findDevice(ctx.db, input.deviceToken!);
  if (!device) return { kind: 'unauthorized' };

  const res = await attemptPin(ctx, device, input.currentPin);
  if (!res.ok) {
    if (res.reason === 'blocked' || res.blocked) return { kind: 'blocked' };
    return { kind: 'wrong', attemptsLeft: res.attemptsLeft };
  }
  const pinHash = await hashPin(device.userId, device.id, input.newPin);
  await ctx.db.update(devices).set({ pinHash }).where(eq(devices.id, device.id));
  await record(ctx, 'pin_change', { userId: device.userId, deviceId: device.id });
  return { kind: 'ok' };
}

// ===== Состояние, блокировка, выход =====

export interface AuthResult {
  state: AuthState;
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  login?: string;
  csrf?: string;
  /** Нужно продлить cookie устройства (скользящий срок 180 дней) */
  refreshDeviceCookie?: boolean;
  /** Cookie устройства недействительна: клиенту её надо очистить */
  clearDeviceCookie?: boolean;
}

export async function getAuthState(
  ctx: Ctx,
  input: { deviceToken?: string | null; sessionToken?: string | null; touch?: boolean },
): Promise<AuthResult> {
  const { db } = ctx;
  const now = ctx.now ?? new Date();
  if (!input.deviceToken) return { state: 'anonymous' };

  const device = await findDevice(db, input.deviceToken);
  if (!device) return { state: 'anonymous', clearDeviceCookie: true };

  const refresh = now.getTime() - device.lastSeenAt.getTime() > AUTH.deviceTouchHours * 3_600_000;
  const base: Pick<AuthResult, 'userId' | 'deviceId' | 'refreshDeviceCookie'> = {
    userId: device.userId,
    deviceId: device.id,
    refreshDeviceCookie: refresh,
  };
  if (refresh && input.touch !== false) {
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));
  }

  if (device.pinBlocked) return { ...base, state: 'anonymous' };
  if (!device.pinHash) {
    const v = device.passwordVerifiedAt;
    const fresh = v && now.getTime() - v.getTime() <= minutes(AUTH.pinSetupWindowMinutes);
    return { ...base, state: fresh ? 'needPinSetup' : 'anonymous' };
  }

  if (input.sessionToken) {
    const tokenHash = sha256Hex(input.sessionToken);
    const [s] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.deviceId, device.id)))
      .limit(1);
    if (s) {
      if (s.expiresAt <= now) {
        await db.delete(sessions).where(eq(sessions.id, s.id));
      } else if (s.lockedAt) {
        return { ...base, state: 'locked', sessionId: s.id };
      } else {
        const idleMs = minutes(getEnv().pinIdleMinutes);
        if (now.getTime() - s.lastActivity.getTime() > idleMs) {
          await db.update(sessions).set({ lockedAt: now }).where(eq(sessions.id, s.id));
          return { ...base, state: 'locked', sessionId: s.id };
        }
        if (input.touch !== false && now.getTime() - s.lastActivity.getTime() > AUTH.activityTouchSeconds * 1000) {
          await db.update(sessions).set({ lastActivity: now }).where(eq(sessions.id, s.id));
        }
        const [u] = await db.select({ login: users.login }).from(users).where(eq(users.id, device.userId)).limit(1);
        return {
          ...base,
          state: 'ok',
          sessionId: s.id,
          login: u?.login,
          csrf: csrfFor(tokenHash),
        };
      }
    }
  }
  return { ...base, state: 'locked' };
}

/** Блокировка на PIN. Сессия остаётся, но до ввода PIN не принимается. */
export async function lockSession(ctx: Ctx, input: { sessionToken: string | null }): Promise<void> {
  if (!input.sessionToken) return;
  const now = ctx.now ?? new Date();
  const rows = await ctx.db
    .update(sessions)
    .set({ lockedAt: now })
    .where(and(eq(sessions.tokenHash, sha256Hex(input.sessionToken)), isNull(sessions.lockedAt)))
    .returning({ userId: sessions.userId, deviceId: sessions.deviceId });
  const r = rows[0];
  if (r) await record(ctx, 'lock', { userId: r.userId, deviceId: r.deviceId });
}

/** Выход: удаляет устройство вместе с сессиями, PIN устройства стирается. */
export async function logout(ctx: Ctx, input: { deviceToken: string | null; sessionToken: string | null }): Promise<void> {
  const { db } = ctx;
  let device = input.deviceToken ? await findDevice(db, input.deviceToken) : null;
  if (!device && input.sessionToken) {
    const [s] = await db
      .select({ deviceId: sessions.deviceId })
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256Hex(input.sessionToken)))
      .limit(1);
    if (s) {
      const [d] = await db.select().from(devices).where(eq(devices.id, s.deviceId)).limit(1);
      device = d ?? null;
    }
  }
  if (!device) return;
  await db.delete(devices).where(eq(devices.id, device.id));
  await record(ctx, 'logout', { userId: device.userId });
}

// ===== Команды владельца =====

export async function createOwner(
  db: Db,
  input: { login: string; password: string },
): Promise<'created' | 'exists'> {
  const login = normalizeLogin(input.login);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.login, login)).limit(1);
  if (existing) return 'exists';
  await db.insert(users).values({ login, passwordHash: await hashPassword(input.password), role: 'owner' });
  return 'created';
}

/** Смена пароля завершает все сессии и стирает PIN на всех устройствах. */
export async function setOwnerPassword(
  db: Db,
  input: { login: string; password: string },
): Promise<'ok' | 'notFound'> {
  const login = normalizeLogin(input.login);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.login, login)).limit(1);
  if (!user) return 'notFound';
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.password), passwordChangedAt: new Date() })
    .where(eq(users.id, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  await db
    .update(devices)
    .set({ pinHash: null, pinFailed: 0, pinBlocked: false, passwordVerifiedAt: null })
    .where(eq(devices.userId, user.id));
  await db.insert(authEvents).values({ kind: 'reset', userId: user.id });
  return 'ok';
}

/** Удаляет все устройства и сессии, пароль не меняется. */
export async function revokeDevices(db: Db, input: { login: string }): Promise<'ok' | 'notFound'> {
  const login = normalizeLogin(input.login);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.login, login)).limit(1);
  if (!user) return 'notFound';
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  await db.delete(devices).where(eq(devices.userId, user.id));
  await db.insert(authEvents).values({ kind: 'reset', userId: user.id });
  return 'ok';
}

