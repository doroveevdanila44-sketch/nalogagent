import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { asc } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Маршрут проверяется целиком: настоящий обработчик, настоящая база (PGlite), только вход
// и выдача подменены, чтобы не поднимать cookies и сессии.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/client', () => ({ getDb: () => h.db, closeDb: async () => undefined }));
vi.mock('@/lib/auth/server', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireApiAuth: async () => ({ ok: true, auth: { userId: 'test-user' } }),
    json: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    failure: (_scope: string, e: unknown) => {
      throw e;
    },
  };
});

import { GET } from '@/app/api/dashboard/route';
import { createOwner } from '@/lib/auth/service';
import type { Db } from '@/lib/db/client';
import { loadCalcData, saveRateChoice } from '@/lib/db/queries';
import { dataSources, revenueMonthly, users } from '@/lib/db/schema';
import { seedDatabase } from '@/lib/db/seed';
import { createTestDb } from '@/lib/db/testing';
import { computeLive, computeStatic } from './dashboard';
import { dec, round2, sum } from './decimal';
import { formatLoadedAt } from './provenance';
import { fromPayload, type DashboardPayload } from './serialize';
import { calcTax, type CalcData, type CalcResult, type TaxKind } from './service';
import { momentFromEpoch } from './time';

/** 2026-10-10 12:00 по Камчатке: так же, как в CALC.md и в тестах чата */
const NOW = Date.UTC(2026, 9, 10, 0, 0, 0);
const TZ = 'Asia/Kamchatka';

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  await seedDatabase(db, { tz: TZ });
  await createOwner(db, { login: 'luxautoowner', password: 'x-test-password-1' });
  [{ id: userId }] = (await db.select({ id: users.id }).from(users).limit(1)) as [{ id: string }];
});
afterAll(async () => close());

async function fetchDashboard(): Promise<DashboardPayload> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  try {
    const res = await GET(new NextRequest('http://localhost/api/dashboard'));
    expect(res.status).toBe(200);
    return (await res.json()) as DashboardPayload;
  } finally {
    vi.useRealTimers();
  }
}

function groupOf(r: CalcResult, id: string) {
  return r.entities.find((e) => e.entityId === id)!;
}

describe('/api/dashboard и расчётный сервис дают одни и те же цифры', () => {
  async function compare(label: string) {
    const payload = await fetchDashboard();
    const input = fromPayload(payload);
    const now = momentFromEpoch(payload.serverNow, payload.tz);
    const stat = computeStatic(input, now);
    const live = computeLive(input, now, stat);
    // тот же снимок базы, что у маршрута
    const data: CalcData = await loadCalcData(db, now);
    const run = (tax: TaxKind, period: Parameters<typeof calcTax>[0]['period']) =>
      calcTax({ entityIds: 'all', tax, period }, data);

    const ytd = { kind: 'ytd' } as const;
    const year = { kind: 'year', year: 2026 } as const;

    const vatYtd = run('vat', ytd);
    const vatYear = run('vat', year);
    const usnYear = run('usn', year);
    const usnYtd = run('usn', ytd);
    const profitYear = run('profit', year);
    const profitYtd = run('profit', ytd);

    // группа
    expect(vatYtd.revenue!.eq(live.ytdGroup), `${label}: выручка с начала года`).toBe(true);
    expect(vatYtd.total!.eq(live.taxAccruedGroup), `${label}: НДС начислен`).toBe(true);
    expect(vatYear.total!.eq(stat.forecastGroup), `${label}: НДС до конца года`).toBe(true);
    expect(vatYear.revenue!.eq(stat.annualGroup), `${label}: выручка года`).toBe(true);
    expect(usnYear.total!.eq(stat.incomeTaxGroup.usn), `${label}: УСН за год`).toBe(true);
    expect(profitYear.total!.eq(stat.incomeTaxGroup.profit), `${label}: прибыль за год`).toBe(true);
    expect(usnYear.total!.plus(profitYear.total!).eq(stat.incomeTaxGroup.total)).toBe(true);

    // юрлица
    for (const e of input.entities) {
      const s = stat.perEntity[e.id]!;
      const l = live.perEntity[e.id]!;
      expect(groupOf(vatYtd, e.id).revenue!.eq(round2(l.ytd)), `${label}: ${e.id} выручка`).toBe(true);
      expect(groupOf(vatYear, e.id).tax!.eq(round2(s.forecast[s.selected]!)), `${label}: ${e.id} НДС год`).toBe(true);
      if (e.status === 'payer') {
        expect(groupOf(vatYtd, e.id).tax!.eq(round2(l.accrued[s.selected]!)), `${label}: ${e.id} НДС на дату`).toBe(true);
      }
      expect(groupOf(vatYear, e.id).rate).toBe(s.selected);
      const own = e.taxRegime === 'osno' ? [profitYear, profitYtd] : [usnYear, usnYtd];
      expect(groupOf(own[0]!, e.id).tax!.eq(round2(s.incomeTax.forecast)), `${label}: ${e.id} налог год`).toBe(true);
      expect(groupOf(own[1]!, e.id).tax!.eq(round2(l.incomeTaxAccrued)), `${label}: ${e.id} налог на дату`).toBe(true);
    }

    // график: помесячная выручка группы
    stat.columns.forEach((col, i) => {
      expect(vatYear.months[i]!.revenue!.eq(col.total), `${label}: колонка ${i + 1}`).toBe(true);
      expect(vatYear.months[i]!.status === 'fact').toBe(col.status === 'fact');
    });
    return { payload, data };
  }

  it('до выбора ставок: источник и признак в ответе, цифры совпадают', async () => {
    const { payload, data } = await compare('по умолчанию');
    expect(payload.source).toEqual(data.source);
    expect(payload.source).toMatchObject({
      id: 'demo-1c',
      kind: 'demo_1c',
      title: 'Выгрузка из 1С',
      isDemo: true,
      loadedAt: '2026-10-10T06:00:00.000Z',
    });
    expect(payload.kind).toBe('mixed');
    expect(formatLoadedAt(payload.source!.loadedAt, payload.tz).replace(/ /g, ' ')).toBe('10 октября 2026, 18:00');
  });

  it('после выбора ставок цифры по-прежнему совпадают', async () => {
    await saveRateChoice(db, { entityId: 'alfa', year: 2026, rate: 22, userId });
    await saveRateChoice(db, { entityId: 'beta', year: 2026, rate: 7, userId });
    const { payload } = await compare('после выбора');
    expect(payload.selections).toMatchObject({ alfa: 22, beta: 7 });
  });
});

describe('сид: один источник, детерминированный и идемпотентный', () => {
  const snapshot = async () => ({
    sources: await db.select().from(dataSources).orderBy(asc(dataSources.id)),
    revenue: await db
      .select()
      .from(revenueMonthly)
      .orderBy(asc(revenueMonthly.entityId), asc(revenueMonthly.year), asc(revenueMonthly.month)),
  });

  it('второй запуск ничего не меняет, при любых часах', async () => {
    const before = await snapshot();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2031, 2, 3, 4, 5, 6)));
    try {
      await seedDatabase(db, { tz: TZ });
      await seedDatabase(db, { tz: TZ });
    } finally {
      vi.useRealTimers();
    }
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('один источник «Выгрузка из 1С», загружен 10 октября 2026, 18:00', async () => {
    const { sources } = await snapshot();
    expect(sources).toHaveLength(1);
    const s = sources[0]!;
    expect(s).toMatchObject({ id: 'demo-1c', kind: 'demo_1c', title: 'Выгрузка из 1С', isDemo: true });
    expect(formatLoadedAt(s.loadedAt.toISOString(), TZ).replace(/ /g, ' ')).toBe('10 октября 2026, 18:00');
  });

  it('пять юрлиц, 2025 и 2026 годы, все строки со ссылкой на источник', async () => {
    const { revenue, sources } = await snapshot();
    expect(revenue).toHaveLength(5 * 2 * 12);
    expect(new Set(revenue.map((r) => r.entityId))).toEqual(new Set(['alfa', 'beta', 'delta', 'gamma', 'epsilon']));
    expect(new Set(revenue.map((r) => r.year))).toEqual(new Set([2025, 2026]));
    expect(revenue.every((r) => r.sourceId === 'demo-1c')).toBe(true);
    expect(revenue.every((r) => r.updatedAt.getTime() === sources[0]!.loadedAt.getTime())).toBe(true);
  });

  it('факт: весь 2025, 2026 по сентябрь включительно; октябрь, ноябрь, декабрь не факт', async () => {
    const { revenue } = await snapshot();
    for (const r of revenue) {
      const expected = r.year === 2025 || r.month <= 9;
      expect(r.isFact, `${r.entityId} ${r.year}-${r.month}`).toBe(expected);
    }
  });

  it('сумма 2026 по юрлицу равна годовому прогнозу, 2025 равна фактическому году', async () => {
    const { revenue } = await snapshot();
    const annual: Record<string, number> = {
      alfa: 28_400_000,
      beta: 22_000_000,
      delta: 20_900_000,
      gamma: 6_400_000,
      epsilon: 74_000_000,
    };
    const prev: Record<string, number> = {
      alfa: 25_100_000,
      beta: 19_800_000,
      delta: 17_600_000,
      gamma: 5_700_000,
      epsilon: 66_500_000,
    };
    for (const id of Object.keys(annual)) {
      const total = (year: number) =>
        sum(revenue.filter((r) => r.entityId === id && r.year === year).map((r) => dec(r.amount)));
      expect(total(2026).eq(annual[id]!), id).toBe(true);
      expect(total(2025).eq(prev[id]!), id).toBe(true);
    }
  });

  it('дата загрузки в любом поясе приложения читается как 18:00 по местному времени', async () => {
    try {
      for (const tz of ['Europe/Moscow', 'Asia/Kamchatka', 'UTC']) {
        await seedDatabase(db, { tz });
        const [s] = await db.select().from(dataSources);
        expect(formatLoadedAt(s!.loadedAt.toISOString(), tz).replace(/ /g, ' ')).toBe('10 октября 2026, 18:00');
      }
    } finally {
      await seedDatabase(db, { tz: TZ });
    }
  });
});

describe('миграция 0002 только добавляет', () => {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const statements = (file: string) =>
    fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

  it('в файле нет ничего, что удаляет или переписывает', () => {
    const list = statements('0002_data_sources.sql');
    expect(list.length).toBeGreaterThan(0);
    for (const st of list) {
      expect(st, st).toMatch(/^(CREATE TABLE|CREATE INDEX|ALTER TABLE "[a-z_]+" ADD (COLUMN|CONSTRAINT))/);
      // действия внешнего ключа (ON DELETE no action) не удаляют ничего сами по себе
      const body = st.replace(/ON (DELETE|UPDATE) (no action|restrict|cascade|set null)/gi, '');
      expect(body, st).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b|ALTER COLUMN/i);
    }
  });

  it('журнал миграций по порядку, у каждой записи есть файл', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    // новые миграции дописываются в конец: прежние идут в том же порядке
    expect(journal.entries.map((e) => e.tag).slice(0, 4)).toEqual([
      '0000_init',
      '0001_tax_regimes',
      '0002_data_sources',
      '0003_provenance_actions',
    ]);
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
    for (const e of journal.entries) expect(fs.existsSync(path.join(dir, `${e.tag}.sql`))).toBe(true);
  });

  it('строки, записанные до миграции, сохраняются: источник пуст, время обновления есть', async () => {
    const old = new PGlite();
    try {
      for (const f of ['0000_init.sql', '0001_tax_regimes.sql']) {
        for (const st of statements(f)) await old.exec(st);
      }
      await old.exec(`insert into legal_entities (id, name, form, owner_label, vat_status, annual_revenue, input_vat_share, color)
                      values ('alfa', 'ООО «Альфа»', 'ООО', 'Собственник 1', 'payer', 28400000, 0.82, '#000000')`);
      await old.exec(`insert into revenue_monthly (entity_id, year, month, amount, is_fact)
                      values ('alfa', 2026, 1, 1988000.00, true), ('alfa', 2026, 2, 1988000.00, true)`);

      for (const st of statements('0002_data_sources.sql')) await old.exec(st);

      const rows = await old.query<{ amount: string; is_fact: boolean; source_id: string | null; updated_at: string | null }>(
        'select amount, is_fact, source_id, updated_at from revenue_monthly order by month',
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((r) => r.amount === '1988000.00' && r.is_fact && r.source_id === null)).toBe(true);
      expect(rows.rows.every((r) => r.updated_at !== null)).toBe(true);
      const sources = await old.query('select * from data_sources');
      expect(sources.rows).toHaveLength(0);

      // ограничение вида источника: пока только demo_1c
      await expect(
        old.exec(`insert into data_sources (id, kind, title, loaded_at) values ('x', 'other', 'x', now())`),
      ).rejects.toThrow();
    } finally {
      await old.close();
    }
  });
});

describe('вторых копий цифр в коде нет', () => {
  const root = process.cwd();
  const skip = new Set(['node_modules', '.next', '.git', '.data', 'test-results', 'pva-handoff', 'e2e', 'docs', 'drizzle']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  // сид и демо-данные: единственное место, где цифры задаются в коде, и только для записи в базу
  const allowed = new Set([
    path.join('lib', 'calc', 'demo-data.ts'),
    path.join('lib', 'db', 'seed.ts'),
  ]);
  const files = ['app', 'components', 'lib', 'scripts'].flatMap((d) =>
    fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : [],
  );

  it('демо-данные подключает только сид', () => {
    const users: string[] = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (allowed.has(rel)) continue;
      const text = fs.readFileSync(f, 'utf8');
      if (/from ['"][^'"]*demo-data['"]|export \* from ['"][^'"]*demo-data['"]/.test(text)) users.push(rel);
    }
    expect(users).toEqual([]);
  });

  it('годовые цифры демо не повторяются в рабочем коде', () => {
    const numbers = /\b(28[_ ]?400[_ ]?000|22[_ ]?000[_ ]?000|20[_ ]?900[_ ]?000|74[_ ]?000[_ ]?000|25[_ ]?100[_ ]?000)\b/;
    const found: string[] = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (allowed.has(rel)) continue;
      if (numbers.test(fs.readFileSync(f, 'utf8'))) found.push(rel);
    }
    expect(found).toEqual([]);
  });
});
