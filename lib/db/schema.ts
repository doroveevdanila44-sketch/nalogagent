import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Схема по docs/schema.sql. Отличия от эталона, все намеренные:
 *  - users: нет failed_logins, locked_until, lock_level. Лимиты по логину и IP считаются из auth_events
 *    (AUTH.md: «в таблице auth_events, а не в памяти процесса»), чтобы для несуществующего логина
 *    ответ был таким же, как для существующего.
 *  - devices.password_verified_at: окно, в течение которого после входа по паролю можно задать PIN.
 *  - sessions.locked_at: блокировка на PIN при простое, сессия на сервере остаётся.
 *  - webauthn_credentials: таблица под вход по биометрии, пока не используется (AUTH.md, «Что отложено»).
 */

const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ===== Вход =====
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    login: text('login').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('owner'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
  },
  (t) => [check('users_login_lower', sql`${t.login} = lower(${t.login})`)],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 токена из cookie pva_device */
    tokenHash: text('token_hash').notNull().unique(),
    /** argon2id; null пока PIN не задан. Открытого PIN нигде нет */
    pinHash: text('pin_hash'),
    pinFailed: integer('pin_failed').notNull().default(0),
    pinBlocked: boolean('pin_blocked').notNull().default(false),
    userAgent: text('user_agent'),
    passwordVerifiedAt: tstz('password_verified_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** sha256 токена из cookie pva_session */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastActivity: tstz('last_activity').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    lockedAt: tstz('locked_at'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_device_id_idx').on(t.deviceId)],
);

/** Журнал попыток для лимитов и аудита. Тела запросов не хранятся. */
export const authEvents = pgTable(
  'auth_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: tstz('at').notNull().defaultNow(),
    /** login_ok, login_fail, login_lock, pin_ok, pin_fail, pin_setup, pin_change, lock, logout, reset */
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    ip: inet('ip'),
    /** HMAC от введённого логина, а не сам текст: в поле логина могут случайно ввести пароль */
    loginTried: text('login_tried'),
  },
  (t) => [
    index('auth_events_kind_at_idx').on(t.kind, t.at),
    index('auth_events_ip_at_idx').on(t.ip, t.at),
    index('auth_events_login_at_idx').on(t.loginTried, t.at),
  ],
);

/** Под вход по биометрии (WebAuthn). Таблица подготовлена, функция не включена. */
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ===== Правила =====
export const rules = pgTable(
  'rules',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    value: numeric('value', { precision: 18, scale: 4 }),
    formula: text('formula'),
    unit: text('unit').notNull().default('rub'),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    norm: text('norm'),
    sourceUrl: text('source_url'),
    note: text('note'),
  },
  (t) => [unique('rules_key_valid_from_unique').on(t.key, t.validFrom)],
);

export const seasonality = pgTable(
  'seasonality',
  {
    month: integer('month').primaryKey(),
    weight: numeric('weight', { precision: 6, scale: 4 }).notNull(),
  },
  (t) => [check('seasonality_month_range', sql`${t.month} between 1 and 12`)],
);

// ===== Группа =====
export const legalEntities = pgTable(
  'legal_entities',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    form: text('form').notNull(),
    ownerLabel: text('owner_label').notNull(),
    vatStatus: text('vat_status').notNull(),
    annualRevenue: numeric('annual_revenue', { precision: 18, scale: 2 }).notNull(),
    /** p: доля закупок с входным НДС */
    inputVatShare: numeric('input_vat_share', { precision: 5, scale: 4 }).notNull(),
    color: text('color').notNull(),
    description: text('description'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [
    check('legal_entities_vat_status', sql`${t.vatStatus} in ('payer','exempt')`),
    check('legal_entities_share_range', sql`${t.inputVatShare} between 0 and 1`),
  ],
);

export const revenueMonthly = pgTable(
  'revenue_monthly',
  {
    entityId: text('entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    isFact: boolean('is_fact').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.year, t.month] }),
    check('revenue_monthly_month_range', sql`${t.month} between 1 and 12`),
  ],
);

/** Выбранная ставка по юрлицу, история сохраняется. Действует последняя запись. */
export const rateChoices = pgTable(
  'rate_choices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    rate: integer('rate').notNull(),
    chosenBy: uuid('chosen_by').references(() => users.id),
    chosenAt: tstz('chosen_at').notNull().defaultNow(),
  },
  (t) => [
    check('rate_choices_rate', sql`${t.rate} in (5,7,22)`),
    index('rate_choices_entity_year_idx').on(t.entityId, t.year, t.chosenAt.desc()),
  ],
);

// ===== Чат =====
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    /** Класс маршрутизатора A..F */
    class: text('class'),
    /** Обычный текст. Разметки внутри нет, интерфейс экранирует всё */
    content: text('content').notNull(),
    /** Структурированный ответ: таблицы, «Как посчитано», ожидающее уточнение */
    calc: jsonb('calc'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('chat_messages_role', sql`${t.role} in ('user','agent')`),
    index('chat_messages_user_created_idx').on(t.userId, t.createdAt.desc()),
  ],
);

export const agentState = pgTable('agent_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  refusalIndex: integer('refusal_index').notNull().default(0),
  greetIndex: integer('greet_index').notNull().default(0),
  lastActive: tstz('last_active'),
});

export const llmUsage = pgTable('llm_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: tstz('at').notNull().defaultNow(),
  provider: text('provider').notNull(),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  latencyMs: integer('latency_ms'),
  ok: boolean('ok').notNull().default(true),
  note: text('note'),
});
