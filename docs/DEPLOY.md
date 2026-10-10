# Развёртывание демо: Vercel и Neon

Код не зависит от Vercel: всё настраивается переменными окружения (`.env.example`). Переезд на Yandex Cloud это смена значений, см. конец файла.

## 1. База (Neon)

1. Создать проект в Neon, регион ближе к пользователям, база `pva`.
2. Взять **pooled**-строку подключения (хост с `-pooler`) для `DATABASE_URL`. Параметр `sslmode=require` в строке оставить.
3. Применить миграции и сид **с локальной машины** (не из сборки Vercel):

```bash
DATABASE_URL='postgres://...' npm run db:migrate
DATABASE_URL='postgres://...' npm run db:seed
```

Повторный сид безопасен: справочники не перезаписываются, помесячная выручка текущего года пересчитывается.

## 2. Пользователь

Пользователь создаётся только командой владельца. Пароль спрашивается без эха и не передаётся аргументами:

```bash
DATABASE_URL='postgres://...' npm run user:create
```

Команда выводит только «создан». Начальный пароль клиенту отправляет Д.Дорофеев сам, вне приложения. Забыли пароль или PIN: `npm run user:set-password` (завершает все сессии и стирает PIN на всех устройствах) или `npm run user:revoke-devices` (пароль не меняется).

## 3. Vercel

1. Импортировать репозиторий в Vercel, Framework Preset: Next.js. Команды по умолчанию.
2. Переменные окружения (Production и Preview):

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | pooled-строка Neon |
| `PIN_PEPPER` | `openssl rand -base64 48` |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `PIN_IDLE_MINUTES` | `5` |
| `PIN_BACKGROUND_SECONDS` | `60` |
| `LLM_PROVIDER` | `stub` |
| `APP_TZ` | `Asia/Kamchatka` |

`PIN_PEPPER` после создания PIN менять нельзя: все PIN перестанут подходить и их придётся создавать заново (`npm run user:revoke-devices`).

3. Деплой. Секреты в репозиторий не попадают: `.env.local` в `.gitignore`.

## 4. Проверка по критериям приёмки (SPEC.md, раздел 9)

1. Без входа доступна только `/login`: `curl -i https://<домен>/agent` отвечает редиректом, `/api/dashboard` отвечает 401.
2. Вход `luxautoowner`, затем создание PIN, открывается «Агент».
3. Перезапуск требует PIN, пятая ошибка блокирует его.
4. Дашборд: четыре юрлица, цифры тикают, выбор ставки переживает перезагрузку и другое устройство.
5. Контрольные числа: `npm test`.
6. Чат отвечает без модели, отказы идут по кругу.
7. Установка на главный экран: iOS через «Поделиться, На экран Домой», Android через меню браузера.
8. Lighthouse (мобильный профиль): на `/login` Performance 96, Accessibility 100 на момент написания.
9. Переменные окружения заданы, секретов в репозитории нет.

## 5. Переезд в Yandex Cloud (этап 7)

- `DATABASE_URL` на Yandex Managed PostgreSQL, `DATABASE_SSL_CA` с корневым сертификатом (PEM, переводы строк как `\n`). Код читает его сам.
- Контейнер: `next build`, затем `next start`, порт из окружения. Нативный модуль `@node-rs/argon2` требует образа на glibc (не alpine).
- Правило `serverExternalPackages` в `next.config.ts` уже учитывает `@node-rs/argon2`, `pg`, `bcryptjs`.
- Фоновых задач сейчас нет, `vercel.json` и cron не используются.
- GigaChat: реализовать `LlmProvider` в `lib/agent/` (интерфейс и общий набор тестов в `lib/agent/agent.test.ts`, функция `contract`), добавить в `lib/agent/provider-factory.ts`.
