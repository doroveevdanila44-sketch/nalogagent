# Агент по НДС

Закрытое PWA для собственника группы компаний: чат с калькулятором НДС и дашборд по юрлицам. Задание и документы лежат в `docs/` (`README.md`, `SPEC.md`, `AUTH.md`, `CALC.md`, `AGENT.md`). Что реализовано иначе и почему: `docs/DECISIONS.md`. Что осталось открытым: `docs/OPEN_QUESTIONS.md`. Деплой: `docs/DEPLOY.md`.

## Быстрый старт

```bash
npm install
cp .env.example .env.local        # заполнить PIN_PEPPER и SESSION_SECRET (openssl rand -base64 48)

npm run db:dev                    # локальный PostgreSQL, держать запущенным в отдельном окне
# DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/pva  (в .env.local)
npm run db:migrate
npm run db:seed
npm run user:create               # пароль спросит без эха

npm run dev                       # http://localhost:3000
```

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev`, `build`, `start` | Next.js |
| `npm test` | юнит-тесты: калькулятор, вход, агент (Vitest, база PGlite в памяти) |
| `npm run test:e2e` | сквозные сценарии (Playwright, нужен `npm run db:dev`, системный Chrome) |
| `npm run typecheck` | проверка типов |
| `npm run db:generate` | миграция по изменениям `lib/db/schema.ts` |
| `npm run db:migrate`, `db:seed` | миграции и демо-данные (идемпотентны) |
| `npm run user:create` | создать `luxautoowner` |
| `npm run user:set-password` | сменить пароль, завершить все сессии, стереть PIN |
| `npm run user:revoke-devices` | удалить все устройства и сессии |
| `npm run icons` | пересоздать иконки PWA |

## Структура

```
app/            страницы и API (App Router)
components/     интерфейс: оболочка, вход и PIN, дашборд, чат
lib/calc/       калькулятор на decimal.js, чистые функции, тесты
lib/agent/      маршрутизатор, ответы, провайдер модели, предохранитель
lib/auth/       пароль, PIN, устройства, сессии, лимиты
lib/db/         схема Drizzle, клиент, сид, запросы
scripts/        команды владельца и служебные скрипты
e2e/            сквозные тесты Playwright
drizzle/        миграции
docs/           задание и принятые решения
```
