// Окружение для юнит-тестов: свои секреты, чтобы тесты не зависели от .env.local.
process.env.PIN_PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.PIN_IDLE_MINUTES = '5';
process.env.PIN_BACKGROUND_SECONDS = '60';
process.env.APP_TZ = 'Asia/Kamchatka';
