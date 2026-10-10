/**
 * Окружение читается лениво, в момент запроса, а не при импорте: сборка `next build`
 * не должна падать из-за отсутствия секретов.
 */
export type LlmProvider = 'stub' | 'gigachat' | 'yandexgpt';

export interface AppEnv {
  databaseUrl: string;
  databaseSslCa: string | null;
  pinPepper: string;
  sessionSecret: string;
  pinIdleMinutes: number;
  pinBackgroundSeconds: number;
  llmProvider: LlmProvider;
  appTz: string;
  isProd: boolean;
  /** Secure у cookies отключается только при NODE_ENV=development */
  secureCookies: boolean;
}

const DEV_PEPPER = 'dev-only-pin-pepper-not-for-production-0123456789';
const DEV_SESSION = 'dev-only-session-secret-not-for-production-0123456789';

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: ожидается положительное число`);
  return n;
}

export function getEnv(): AppEnv {
  const e = process.env;
  const isProd = e.NODE_ENV === 'production';

  const pinPepper = e.PIN_PEPPER || (isProd ? '' : DEV_PEPPER);
  const sessionSecret = e.SESSION_SECRET || (isProd ? '' : DEV_SESSION);
  if (isProd) {
    if (pinPepper.length < 32) throw new Error('PIN_PEPPER не задан или короче 32 символов');
    if (sessionSecret.length < 32) throw new Error('SESSION_SECRET не задан или короче 32 символов');
  }

  const provider = (e.LLM_PROVIDER || 'stub') as LlmProvider;
  if (!['stub', 'gigachat', 'yandexgpt'].includes(provider)) {
    throw new Error('LLM_PROVIDER: допустимо stub, gigachat, yandexgpt');
  }

  return {
    databaseUrl: e.DATABASE_URL ?? '',
    databaseSslCa: e.DATABASE_SSL_CA ? e.DATABASE_SSL_CA.replace(/\\n/g, '\n') : null,
    pinPepper,
    sessionSecret,
    pinIdleMinutes: positiveInt(e.PIN_IDLE_MINUTES, 5, 'PIN_IDLE_MINUTES'),
    pinBackgroundSeconds: positiveInt(e.PIN_BACKGROUND_SECONDS, 60, 'PIN_BACKGROUND_SECONDS'),
    llmProvider: provider,
    appTz: e.APP_TZ || 'Asia/Kamchatka',
    isProd,
    secureCookies: e.NODE_ENV !== 'development',
  };
}
