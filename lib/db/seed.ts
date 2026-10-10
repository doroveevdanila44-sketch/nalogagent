import { sql } from 'drizzle-orm';
import { round2, dec } from '@/lib/calc/decimal';
import { SEED_ENTITIES, SEED_RULE_ROWS, SEED_WEIGHTS } from '@/lib/calc/demo-data';
import type { Db } from './client';
import { legalEntities, revenueMonthly, rules, seasonality } from './schema';

/**
 * Сид выдуманных данных демо. Идемпотентен:
 *  - правила и веса вставляются, существующие записи не трогаются, чтобы правка владельца
 *    (например, дефлятор) не затиралась повторным запуском;
 *  - юрлица демо вставляются и ОБНОВЛЯЮТСЯ (название, цифры, режим налогообложения): сид
 *    приводит демо-данные к описанным в CALC.md;
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
        taxRegime: e.taxRegime,
        usnRate: e.usnRate ? e.usnRate.toFixed(4) : null,
        annualExpenses: e.annualExpenses.toFixed(2),
      })),
    )
    .onConflictDoUpdate({
      target: legalEntities.id,
      set: {
        name: sql`excluded.name`,
        form: sql`excluded.form`,
        ownerLabel: sql`excluded.owner_label`,
        vatStatus: sql`excluded.vat_status`,
        annualRevenue: sql`excluded.annual_revenue`,
        inputVatShare: sql`excluded.input_vat_share`,
        color: sql`excluded.color`,
        description: sql`excluded.description`,
        sort: sql`excluded.sort`,
        taxRegime: sql`excluded.tax_regime`,
        usnRate: sql`excluded.usn_rate`,
        annualExpenses: sql`excluded.annual_expenses`,
      },
    });

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
