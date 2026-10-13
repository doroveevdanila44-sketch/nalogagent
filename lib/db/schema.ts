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

/** bytea: файл Excel, приложенный к запросу на проверку. node-postgres отдаёт Buffer, PGlite Uint8Array. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});

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

/**
 * Настройки пользователя. Пока одна: когда пройдено обучение (тур по приложению). Хранится в базе,
 * а не в браузере, чтобы тур не повторялся на другом устройстве и после очистки данных сайта.
 * null: обучение ещё не показывалось.
 */
export const userPrefs = pgTable('user_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  onboardingSeenAt: tstz('onboarding_seen_at'),
});

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
    /** Система налогообложения: usn_income, usn_income_expense, osno */
    taxRegime: text('tax_regime').notNull().default('usn_income'),
    /** Ставка УСН долей (0.06, 0.15). null: брать из rules по режиму. Для ОСНО не используется */
    usnRate: numeric('usn_rate', { precision: 5, scale: 4 }),
    /** Расходы за год без НДС: для УСН «доходы минус расходы» и налога на прибыль */
    annualExpenses: numeric('annual_expenses', { precision: 18, scale: 2 }).notNull().default('0'),
    /**
     * Реквизиты для документов: ИНН, КПП, ОГРН, адрес, подписант, банк. В демо вымышленные
     * (в объекте demo: true). null: реквизиты не заведены, поля документа останутся пустыми.
     */
    requisites: jsonb('requisites'),
  },
  (t) => [
    check('legal_entities_vat_status', sql`${t.vatStatus} in ('payer','exempt')`),
    check('legal_entities_share_range', sql`${t.inputVatShare} between 0 and 1`),
    check(
      'legal_entities_tax_regime',
      sql`${t.taxRegime} in ('usn_income','usn_income_expense','osno')`,
    ),
    check('legal_entities_usn_rate_range', sql`${t.usnRate} is null or ${t.usnRate} between 0 and 1`),
  ],
);

/**
 * Откуда пришли цифры. В демо один источник: условная выгрузка из 1С (kind demo_1c).
 * Все цифры дашборда, чата, документов и выгрузок идут из таблиц базы, а у помесячной выручки
 * есть ссылка на источник и дата обновления: по ним расчёт показывает происхождение числа.
 */
export const dataSources = pgTable(
  'data_sources',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    isDemo: boolean('is_demo').notNull().default(true),
    loadedAt: tstz('loaded_at').notNull(),
  },
  (t) => [check('data_sources_kind', sql`${t.kind} in ('demo_1c')`)],
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
    /** Источник строки. null только у строк, записанных до появления data_sources */
    sourceId: text('source_id').references(() => dataSources.id),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
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

// ===== Действия над расчётом: сверка, передача специалисту =====

/**
 * Вымышленный справочник получателей для «Передать специалисту» (демо). Настоящих людей и адресов
 * здесь нет: имена выдуманы, письма не отправляются.
 */
export const people = pgTable('people', {
  id: text('id').primaryKey(),
  /** Вымышленное имя, видно в окне передачи и в статусах */
  name: text('name').notNull(),
  /** Роль: «Бухгалтер», «Финансовый директор» */
  role: text('role').notNull(),
  sort: integer('sort').notNull().default(0),
});

/**
 * Отметки «сверил» из экрана «Проверить самому»: кто, что, когда. subject это ключ расчёта
 * (налог, период, юрлица, ставка), item пункт чек-листа внутри него.
 */
export const checks = pgTable(
  'checks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    item: text('item').notNull(),
    /** Итог расчёта на момент отметки, строкой: по нему видно, что именно сверено */
    amount: text('amount'),
    checkedAt: tstz('checked_at').notNull().defaultNow(),
  },
  (t) => [unique('checks_user_subject_item_unique').on(t.userId, t.subject, t.item)],
);

/**
 * Запрос на проверку специалисту (демо). Снимок расчёта и Excel сохраняются в момент отправки,
 * поэтому история показывает ровно то, что видел пользователь. Реальной отправки нет.
 */
export const reviewRequests = pgTable(
  'review_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Тип запроса: пока только расчёт */
    type: text('type').notNull().default('calc'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => people.id),
    comment: text('comment').notNull().default(''),
    /** sent: «Отправлено на проверку». Остальные значения под будущую обработку специалистом */
    status: text('status').notNull().default('sent'),
    /** Заголовок для списка: «НДС, ООО «Альфа», февраль 2026» */
    title: text('title').notNull(),
    /** Снимок результатов расчёта (CalcSnapshot[]), деньги строками */
    snapshot: jsonb('snapshot').notNull(),
    excelName: text('excel_name').notNull(),
    excelFile: bytea('excel_file').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('review_requests_type', sql`${t.type} in ('calc')`),
    check('review_requests_status', sql`${t.status} in ('sent','in_review','confirmed','returned')`),
    index('review_requests_user_created_idx').on(t.createdBy, t.createdAt.desc()),
  ],
);

// ===== Документы: шаблоны, документы, версии, комментарии, история =====

/**
 * Каталог шаблонов. Заполняется сидом из lib/documents/templates.ts. Все шаблоны образцы:
 * юридически не проверены, в интерфейсе у каждого пометка «Образец, проверить юристом».
 */
export const documentTemplates = pgTable('document_templates', {
  key: text('key').primaryKey(),
  /** contract, addendum, report, declaration */
  category: text('category').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  /** Текст с полями {{ключ}} */
  body: text('body').notNull(),
  /** Список полей: ключ, подпись, тип, источник (entity, calc, user), обязательное */
  fields: jsonb('fields').notNull(),
  /** entity: документ по одному юрлицу, group: по группе */
  scope: text('scope').notNull().default('entity'),
  /** Нужен ли период (месяц, квартал, год, с начала года) */
  needsPeriod: boolean('needs_period').notNull().default(false),
  /** docx или xlsx */
  output: text('output').notNull().default('docx'),
  /** Налоги, на которых стоят суммы шаблона: для подбора из ответа чата */
  taxes: jsonb('taxes').notNull().default([]),
  sort: integer('sort').notNull().default(0),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateKey: text('template_key')
      .notNull()
      .references(() => documentTemplates.key),
    title: text('title').notNull(),
    /** null для документов по группе */
    entityId: text('entity_id').references(() => legalEntities.id),
    /** Period из lib/calc/period.ts или null, если шаблон без периода */
    period: jsonb('period'),
    /** draft, review, remarks, approved, withdrawn */
    status: text('status').notNull().default('draft'),
    currentVersion: integer('current_version').notNull().default(1),
    /** Получатель последней отправки на проверку (вымышленный справочник people) */
    reviewerId: text('reviewer_id').references(() => people.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    /**
     * Мягкое удаление черновика: момент удаления. Такой документ нигде не показывается, до 24 часов
     * его можно вернуть, потом строка удаляется окончательно вместе с версиями и комментариями.
     */
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('documents_status', sql`${t.status} in ('draft','review','remarks','approved','withdrawn')`),
    index('documents_user_updated_idx').on(t.createdBy, t.updatedAt.desc()),
  ],
);

/**
 * Версия документа: неизменяемый снимок (шаблон, значения полей, расчёты, список изменений).
 * Правка создаёт новую версию, прежняя остаётся как была: обновление строки запрещено триггером.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    /** Тело и поля шаблона на момент версии */
    body: text('body').notNull(),
    fields: jsonb('fields').notNull(),
    /** Значения полей: ключ → {value, source, label}; деньги строками из расчёта */
    values: jsonb('values').notNull(),
    /** Снимки расчётов (CalcSnapshot[]), из которых взяты суммы */
    calc: jsonb('calc').notNull().default([]),
    /** Что изменилось относительно прошлой версии */
    changes: jsonb('changes').notNull().default([]),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    /** sha256 от канонической записи тела, значений и расчётов */
    hash: text('hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('document_versions_doc_n_unique').on(t.documentId, t.n)],
);

export const documentComments = pgTable(
  'document_comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** К какой версии относится комментарий */
    versionN: integer('version_n').notNull(),
    /** Поле или абзац документа; null: к документу целиком */
    fieldKey: text('field_key'),
    /** comment, remark (замечание), approval (согласование) */
    kind: text('kind').notNull().default('comment'),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorPersonId: text('author_person_id').references(() => people.id),
    authorName: text('author_name').notNull(),
    /** Ответ имитирован кнопкой «Имитировать ответ бухгалтера» */
    isDemo: boolean('is_demo').notNull().default(false),
    resolved: boolean('resolved').notNull().default(false),
    resolvedAt: tstz('resolved_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('document_comments_kind', sql`${t.kind} in ('comment','remark','approval')`),
    index('document_comments_doc_idx').on(t.documentId, t.createdAt),
  ],
);

/** Лента истории документа: создание, версии, отправка, ответы, согласование, отзыв. */
export const documentEvents = pgTable(
  'document_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** created, version, submitted, withdrawn, comment, remark, approval, resolved */
    kind: text('kind').notNull(),
    versionN: integer('version_n'),
    actor: text('actor').notNull(),
    data: jsonb('data').notNull().default({}),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('document_events_doc_idx').on(t.documentId, t.createdAt)],
);
