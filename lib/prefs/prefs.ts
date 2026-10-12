import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { userPrefs } from '@/lib/db/schema';

/**
 * Настройки пользователя (таблица user_prefs). Сейчас одна: когда показано обучение. Строки у
 * пользователя может не быть: это то же, что «обучение ещё не показывалось».
 */

export interface Prefs {
  /** ISO-время, когда обучение закрыто (пройдено или пропущено); null: ещё не показывалось */
  onboardingSeenAt: string | null;
}

export async function getPrefs(db: Db, userId: string): Promise<Prefs> {
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  return { onboardingSeenAt: row?.onboardingSeenAt?.toISOString() ?? null };
}

/**
 * Отмечает, что обучение показано. Повторный вызов время не сдвигает: «первый раз» остаётся
 * первым, даже если человек потом пересматривает обучение из меню.
 */
export async function markOnboardingSeen(db: Db, args: { userId: string; nowMs: number }): Promise<Prefs> {
  const at = new Date(args.nowMs);
  const [row] = await db
    .insert(userPrefs)
    .values({ userId: args.userId, onboardingSeenAt: at })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { onboardingSeenAt: sql`coalesce(${userPrefs.onboardingSeenAt}, ${at.toISOString()}::timestamptz)` },
    })
    .returning({ at: userPrefs.onboardingSeenAt });
  return { onboardingSeenAt: row?.at?.toISOString() ?? null };
}
