-- Схема Postgres для «Агент по НДС». Подходит для Neon (демо) и Yandex Managed PostgreSQL (финал).
-- Реализовать через Drizzle ORM миграциями; этот файл является эталоном структуры и сидов.
-- Деньги: numeric(18,2). Время: timestamptz.
-- Расхождения рабочей Drizzle-схемы с этим эталоном перечислены в шапке lib/db/schema.ts.
-- Единая демо-база: все цифры дашборда, чата, документов и выгрузок идут из этих таблиц.

create extension if not exists pgcrypto;

-- ===== Вход (см. AUTH.md) =====
-- Реальная схема входа отличается от этого файла (лимиты в auth_events, devices.password_verified_at,
-- sessions.locked_at, webauthn_credentials): см. docs/DECISIONS.md и lib/db/schema.ts.
create table users (
  id            uuid primary key default gen_random_uuid(),
  login         text not null unique check (login = lower(login)),
  password_hash text not null,                 -- argon2id
  role          text not null default 'owner',
  failed_logins int  not null default 0,
  locked_until  timestamptz,
  lock_level    int  not null default 0,        -- для удвоения блокировки
  created_at    timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null unique,           -- sha256 токена из cookie pva_device
  pin_hash      text,                           -- argon2id, null пока PIN не задан. Открытого PIN нигде нет
  pin_failed    int  not null default 0,
  pin_blocked   boolean not null default false,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index on devices(user_id);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  device_id     uuid not null references devices(id) on delete cascade,
  token_hash    text not null unique,           -- sha256 токена из cookie pva_session
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index on sessions(user_id);

-- журнал попыток для лимитов и аудита; тела запросов не хранить
create table auth_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  kind       text not null,                     -- login_ok, login_fail, pin_ok, pin_fail, pin_setup, lock, logout, reset
  user_id    uuid references users(id) on delete set null,
  device_id  uuid references devices(id) on delete set null,
  ip         inet,
  login_tried text
);
create index on auth_events(kind, at);
create index on auth_events(ip, at);

-- ===== Правила (см. CALC.md) =====
create table rules (
  id          bigserial primary key,
  key         text not null,
  value       numeric(18,4),
  formula     text,                             -- если значение вычисляется (дефлятор)
  unit        text not null default 'rub',      -- rub, percent, count, text
  valid_from  date not null,
  valid_to    date,
  norm        text,                             -- статья НК
  source_url  text,
  note        text,
  unique (key, valid_from)
);

create table seasonality (
  month  int primary key check (month between 1 and 12),
  weight numeric(6,4) not null
);

-- ===== Группа =====
create table legal_entities (
  id          text primary key,                 -- alfa, beta, delta, gamma, epsilon
  name        text not null,
  form        text not null,                    -- ООО, ИП
  owner_label text not null,
  vat_status  text not null check (vat_status in ('payer','exempt')),
  annual_revenue numeric(18,2) not null,        -- прогноз года
  input_vat_share numeric(5,4) not null check (input_vat_share between 0 and 1),  -- p
  color       text not null,
  description text,
  sort        int not null default 0,
  -- система налогообложения; для osno ставка НДС одна: 22% с вычетами
  tax_regime  text not null default 'usn_income'
              check (tax_regime in ('usn_income','usn_income_expense','osno')),
  -- ставка УСН долей (0.06, 0.15); null: брать из rules по режиму
  usn_rate    numeric(5,4) check (usn_rate is null or usn_rate between 0 and 1),
  -- расходы за год без НДС: для УСН «доходы минус расходы» и налога на прибыль
  annual_expenses numeric(18,2) not null default 0
);

-- ===== Источники данных =====
-- Откуда пришли цифры. В демо один источник: условная выгрузка из 1С.
-- Второй источник не заводится: расчётный сервис показывает происхождение каждой цифры по этой таблице.
create table data_sources (
  id        text primary key,                   -- demo-1c
  kind      text not null check (kind in ('demo_1c')),
  title     text not null,                      -- «Выгрузка из 1С (демо)»
  is_demo   boolean not null default true,
  loaded_at timestamptz not null               -- когда загружена выгрузка
);

-- Помесячная выручка с НДС. Факт: is_fact = true; прогноз месяца: годовой прогноз юрлица × вес сезонности.
-- Идущий месяц хранится как прогноз (is_fact = false), как «частично факт» его показывает расчёт по дате.
create table revenue_monthly (
  entity_id text not null references legal_entities(id) on delete cascade,
  year      int  not null,
  month     int  not null check (month between 1 and 12),
  amount    numeric(18,2) not null,
  is_fact   boolean not null default false,
  -- у строк, записанных до появления data_sources, пусто; сид заполняет
  source_id text references data_sources(id),
  updated_at timestamptz not null default now(),
  primary key (entity_id, year, month)
);

-- выбранная ставка по юрлицу; история сохраняется
create table rate_choices (
  id         bigserial primary key,
  entity_id  text not null references legal_entities(id) on delete cascade,
  year       int  not null,
  rate       int  not null check (rate in (5,7,22)),
  chosen_by  uuid references users(id),
  chosen_at  timestamptz not null default now()
);
create index on rate_choices(entity_id, year, chosen_at desc);

-- ===== Чат =====
create table chat_messages (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('user','agent')),
  class      text,                              -- A..F
  content    text not null,                     -- текст или безопасный HTML заготовок
  calc       jsonb,                             -- для блока «Как посчитано»
  created_at timestamptz not null default now()
);
create index on chat_messages(user_id, created_at desc);

create table agent_state (
  user_id       uuid primary key references users(id) on delete cascade,
  refusal_index int not null default 0,
  greet_index   int not null default 0,
  last_active   timestamptz
);

create table llm_usage (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  provider    text not null,
  model       text,
  tokens_in   int,
  tokens_out  int,
  latency_ms  int,
  ok          boolean not null default true,
  note        text
);

-- ===== Сиды (выдуманные данные демо) =====
-- Сид детерминирован (не зависит от часов) и идемпотентен: повторный запуск возвращает те же значения.
-- Один источник, дата загрузки 10 октября 2026, 18:00 по часовому поясу приложения (APP_TZ).
-- В SQL ниже время записано для APP_TZ = Asia/Kamchatka; скрипт сида переводит его в APP_TZ сам.
insert into data_sources(id, kind, title, is_demo, loaded_at) values
 ('demo-1c','demo_1c','Выгрузка из 1С (демо)',true,'2026-10-10 18:00:00+12');

insert into seasonality(month, weight) values
 (1,.07),(2,.07),(3,.07),(4,.05),(5,.06),(6,.09),(7,.13),(8,.14),(9,.10),(10,.06),(11,.05),(12,.11);

-- Все юрлица и цифры условные (демо). Сид обновляет существующие строки (on conflict do update).
insert into legal_entities(id,name,form,owner_label,vat_status,annual_revenue,input_vat_share,color,description,sort,tax_regime,usn_rate,annual_expenses) values
 ('alfa','ООО «Альфа»','ООО','Собственник 1','payer', 28400000,.82,'#5A5C2F','Аренда без экипажа: люкс и внедорожники',1,'usn_income',.06,0),
 ('beta','ИП Бета','ИП','Собственник 1','payer', 22000000,.34,'#784244','Аренда без экипажа: комфорт и внедорожники',2,'usn_income_expense',.15,15400000),
 ('delta','ИП Дельта','ИП','Собственник 2','exempt',20900000,.18,'#A0D2A8','Аренда без экипажа: комфорт',3,'usn_income',.06,0),
 ('gamma','ООО «Гамма»','ООО','Собственник 2','exempt', 6400000,.80,'#FFF3B2','Аренда с экипажем и трансферы',4,'usn_income_expense',.15,5200000),
 ('epsilon','ООО «Эпсилон»','ООО','Собственник 1','payer',74000000,.55,'#2A2B14','Демо: условное юрлицо на ОСНО, данные выдуманы',5,'osno',null,44000000);

insert into rules(key,value,unit,valid_from,valid_to,norm,note) values
 ('vat_exempt_limit', 20000000,'rub','2026-01-01','2026-12-31','НК РФ, ст. 145','Порог освобождения'),
 ('limit_5',          272500000,'rub','2026-01-01','2026-12-31','НК РФ, ст. 164','Верхняя граница для ставки 5%'),
 ('limit_7',          490500000,'rub','2026-01-01','2026-12-31','НК РФ, ст. 164','Верхняя граница для ставки 7%'),
 ('rate_special_5',   5,'percent','2026-01-01','2026-12-31','НК РФ, ст. 164','Без вычетов'),
 ('rate_special_7',   7,'percent','2026-01-01','2026-12-31','НК РФ, ст. 164','Без вычетов'),
 ('rate_general',     22,'percent','2026-01-01','2026-12-31','НК РФ, ст. 164','С вычетами'),
 ('twelve_quarters',  12,'count','2026-01-01','2026-12-31',null,'Ограничение возврата к прежней ставке'),
 ('profit_tax_rate',  25,'percent','2026-01-01','2026-12-31','НК РФ, ст. 284','Налог на прибыль. Проверить с бухгалтером'),
 ('usn_rate_income',  6,'percent','2026-01-01','2026-12-31','НК РФ, ст. 346.20, п. 1','УСН «доходы». Проверить с бухгалтером'),
 ('usn_rate_income_expense',15,'percent','2026-01-01','2026-12-31','НК РФ, ст. 346.20, п. 2','УСН «доходы минус расходы». Проверить с бухгалтером'),
 ('usn_min_tax_rate', 1,'percent','2026-01-01','2026-12-31','НК РФ, ст. 346.18, п. 6','Минимальный налог УСН от доходов. Проверить с бухгалтером'),
 ('payment_day',      28,'count','2026-01-01','2026-12-31','НК РФ, ст. 174, 287, 346.21','День месяца срока уплаты. Проверить с бухгалтером');

insert into rules(key,formula,unit,valid_from,note) values
 ('limit_5','250000000 * deflator','rub','2027-01-01','Дефлятор на 2027 год не утверждён'),
 ('limit_7','450000000 * deflator','rub','2027-01-01','Дефлятор на 2027 год не утверждён');

-- Помесячная выручка пяти юрлиц за 2025 и 2026 годы заполняется скриптом сида (npm run db:seed),
-- всем строкам source_id = 'demo-1c', updated_at = loaded_at источника:
--   2026: round(annual_revenue * weight, 2) по месяцам; is_fact = true по сентябрь включительно,
--         октябрь идёт (прогноз месяца, is_fact = false), ноябрь и декабрь прогноз;
--   2025: факт прошлого года, все двенадцать месяцев is_fact = true (годовые суммы и доли в lib/calc/demo-data.ts).
-- Пользователь luxautoowner создаётся командой npm run user:create, а не сидом.
