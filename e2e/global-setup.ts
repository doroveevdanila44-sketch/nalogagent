import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FullConfig } from '@playwright/test';
import { createOwner } from '../lib/auth/service';
import { seedDatabase } from '../lib/db/seed';
import * as schema from '../lib/db/schema';
import { E2E_DB, E2E_DB_URL } from '../playwright.config';

const ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

async function ensureServer(): Promise<void> {
  const probe = new Client({ connectionString: ADMIN_URL });
  try {
    await probe.connect();
    await probe.end();
  } catch {
    throw new Error('Локальный Postgres не запущен. Запустите: npm run db:dev');
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  await ensureServer();

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${E2E_DB} with (force)`);
  await admin.query(`create database ${E2E_DB}`);
  await admin.end();

  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });

  // Те же секреты, что у сервера: хэши PIN и логина считаются с ними
  process.env.PIN_PEPPER = 'e2e-pepper-0123456789abcdef0123456789abcdef-xyz';
  process.env.SESSION_SECRET = 'e2e-session-secret-0123456789abcdef0123456789-xyz';

  const now = new Date();
  await seedDatabase(db as never, { year: now.getFullYear(), month: now.getMonth() + 1 });

  const password = `E2e-${randomBytes(12).toString('base64url')}`;
  await createOwner(db as never, { login: 'luxautoowner', password });
  await client.end();

  // Пароль нужен только тестам этого прогона; файл в .data (в .gitignore)
  fs.mkdirSync('.data', { recursive: true });
  fs.writeFileSync('.data/e2e-password', password, { mode: 0o600 });
}
