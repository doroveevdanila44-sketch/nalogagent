import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { createTestDb } from '@/lib/db/testing';
import { getPrefs, markOnboardingSeen } from './prefs';

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [u] = await db.insert(users).values({ login: 'owner-prefs', passwordHash: 'x' }).returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  await close();
});

describe('настройки пользователя', () => {
  it('до первого показа обучение не отмечено', async () => {
    expect(await getPrefs(db, userId)).toEqual({ onboardingSeenAt: null });
  });

  it('отметка сохраняется в базе и читается обратно', async () => {
    const first = Date.UTC(2026, 9, 12, 7, 0, 0);
    const set = await markOnboardingSeen(db, { userId, nowMs: first });
    expect(set.onboardingSeenAt).toBe(new Date(first).toISOString());
    expect(await getPrefs(db, userId)).toEqual({ onboardingSeenAt: new Date(first).toISOString() });
  });

  it('повторная отметка время первого показа не сдвигает', async () => {
    const first = (await getPrefs(db, userId)).onboardingSeenAt;
    const later = await markOnboardingSeen(db, { userId, nowMs: Date.UTC(2026, 9, 20, 9, 0, 0) });
    expect(later.onboardingSeenAt).toBe(first);
  });

  it('у другого пользователя своя отметка', async () => {
    const [u] = await db.insert(users).values({ login: 'owner-prefs-2', passwordHash: 'x' }).returning({ id: users.id });
    expect(await getPrefs(db, u!.id)).toEqual({ onboardingSeenAt: null });
  });
});
