import bcrypt from 'bcryptjs';
import { getEnv } from '@/lib/env';
import { hmacHex } from './crypto';

/**
 * Пароль: argon2id (@node-rs/argon2), параметры не ниже рекомендаций OWASP
 * (m = 46 МиБ, t = 2, p = 1). Если нативный модуль недоступен на платформе,
 * запасной bcryptjs со стоимостью 12. Формат хэша самоописывающий, проверка выбирает алгоритм по префиксу.
 */
const ARGON_PARAMS = { memoryCost: 47_104, timeCost: 2, parallelism: 1 } as const;
const BCRYPT_COST = 12;

interface ArgonModule {
  hash(password: string, options?: Record<string, unknown>): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

let argonPromise: Promise<ArgonModule | null> | null = null;

function loadArgon(): Promise<ArgonModule | null> {
  if (!argonPromise) {
    argonPromise = import('@node-rs/argon2')
      .then((m) => m as unknown as ArgonModule)
      .catch(() => {
        console.warn('[auth] @node-rs/argon2 недоступен, используется bcryptjs');
        return null;
      });
  }
  return argonPromise;
}

export async function hashSecret(secret: string): Promise<string> {
  const argon = await loadArgon();
  if (argon) return argon.hash(secret, ARGON_PARAMS);
  return bcrypt.hash(secret, BCRYPT_COST);
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    if (hash.startsWith('$argon2')) {
      const argon = await loadArgon();
      if (!argon) return false;
      return await argon.verify(hash, secret);
    }
    if (hash.startsWith('$2')) return await bcrypt.compare(secret, hash);
  } catch {
    return false;
  }
  return false;
}

export const hashPassword = hashSecret;
export const verifyPassword = verifySecret;

/**
 * PIN хэшируется не сам по себе: к строке `userId:deviceId:PIN` применяется HMAC с серверным
 * секретом PIN_PEPPER, затем argon2id. Без PIN_PEPPER дамп базы не позволяет перебрать 10 000 вариантов.
 */
function pinMaterial(userId: string, deviceId: string, pin: string): string {
  return hmacHex(getEnv().pinPepper, `${userId}:${deviceId}:${pin}`);
}

export function hashPin(userId: string, deviceId: string, pin: string): Promise<string> {
  return hashSecret(pinMaterial(userId, deviceId, pin));
}

export function verifyPin(hash: string, userId: string, deviceId: string, pin: string): Promise<boolean> {
  return verifySecret(hash, pinMaterial(userId, deviceId, pin));
}

let dummy: Promise<string> | null = null;

/** Проверка пароля для несуществующего логина занимает столько же времени, сколько для существующего. */
export function dummyPasswordHash(): Promise<string> {
  if (!dummy) dummy = hashSecret('pva-timing-equalizer-not-a-real-password');
  return dummy;
}
