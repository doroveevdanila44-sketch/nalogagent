import { defineConfig, devices } from '@playwright/test';

const PORT = 3101;
const DB_PORT = 54329;
export const E2E_DB = 'pva_e2e';
export const E2E_DB_URL = `postgres://postgres:postgres@127.0.0.1:${DB_PORT}/${E2E_DB}`;
export const SERVER_LOG = '.data/e2e-server.log';

/**
 * Сквозные сценарии входа и основных экранов. Сервер production-сборки на порту 3101,
 * отдельная база pva_e2e, короткие пороги простоя, чтобы не ждать 5 минут.
 * Пароль владельца генерируется в globalSetup на каждый прогон и в логах не появляется.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'ru-RU',
    timezoneId: 'Asia/Kamchatka',
    trace: 'off',
  },
  // Системный Chrome: не требует отдельной загрузки браузера Playwright. Проект WebKit с iPhone
  // включается PW_WEBKIT=1 на машине, где Playwright поддерживает WebKit (на macOS 13 не поддерживает):
  // он прогоняет тест оболочки (шапка и нижняя панель не двигаются при прокрутке) и тест экранной
  // клавиатуры (поле ввода над клавиатурой, iPhone 390 на 844 и 375 на 667) на движке Safari.
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    ...(process.env.PW_WEBKIT
      ? [{ name: 'webkit-iphone', testMatch: /(shell|keyboard)\.spec\.ts/, use: { ...devices['iPhone 14'] } }]
      : []),
  ],
  webServer: {
    command: `mkdir -p .data && npm run build && npx next start -p ${PORT} > ${SERVER_LOG} 2>&1`,
    url: `http://localhost:${PORT}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DB_URL,
      PIN_PEPPER: 'e2e-pepper-0123456789abcdef0123456789abcdef-xyz',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789-xyz',
      PIN_IDLE_MINUTES: '0.25',
      PIN_BACKGROUND_SECONDS: '60',
      APP_TZ: 'Asia/Kamchatka',
      LLM_PROVIDER: 'stub',
    },
  },
});
