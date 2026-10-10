import { sql } from 'drizzle-orm';
import { round2, dec } from '@/lib/calc/decimal';
import { SEED_ENTITIES, SEED_RULE_ROWS, SEED_WEIGHTS } from '@/lib/calc/demo-data';
import type { Db } from './client';
import { legalEntities, revenueMonthly, rules, seasonality } from './schema';

/**
 * Сид выдуманных данных демо. Идемпотентен:
 *  - справочники (правила, юрлица, веса) вставляются, существующие записи не трогаются,
 *    чтобы правка владельца (например, дефлятор) не затиралась повторным запуском;
 *  - помесячная выручка текущего года пересчитывается: is_fact = месяц меньше текущего.
 * Пользователь luxautoowner сидом не создаётся, только командой npm run user:create.
 */
export async function seedDatabase(db: Db, now: { year: number; month: number }): Promise<void> {
  await db
    .insert(seasonality)
    .values(SEED_WEIGHTS.map((w, i) => ({ month: i + 1, weight: w.toFixed(4) })))
    .onConflictDoNothing();

  await db
    .insert(legalEntities)
    .values(
      SEED_ENTITIES.map((e, i) => ({
        id: e.id,
        name: e.name,
        form: e.form,
        ownerLabel: e.ownerLabel,
        vatStatus: e.status,
        annualRevenue: e.annualRevenue.toFixed(2),
        inputVatShare: e.inputVatShare.toFixed(4),
        color: e.color,
        description: e.description,
        sort: i + 1,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(rules)
    .values(
      SEED_RULE_ROWS.map((r) => ({
        key: r.key,
        value: r.value,
        formula: r.formula,
        unit: r.unit,
        validFrom: r.validFrom,
        validTo: r.validTo,
        norm: r.norm ?? null,
        note: r.note ?? null,
      })),
    )
    .onConflictDoNothing();

  const monthly = SEED_ENTITIES.flatMap((e) =>
    SEED_WEIGHTS.map((w, i) => ({
      entityId: e.id,
      year: now.year,
      month: i + 1,
      amount: round2(dec(e.annualRevenue).times(w)).toFixed(2),
      isFact: i + 1 < now.month,
    })),
  );
  await db
    .insert(revenueMonthly)
    .values(monthly)
    .onConflictDoUpdate({
      target: [revenueMonthly.entityId, revenueMonthly.year, revenueMonthly.month],
      set: { amount: sql`excluded.amount`, isFact: sql`excluded.is_fact` },
    });
}
