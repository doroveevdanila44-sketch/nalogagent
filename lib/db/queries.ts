import { and, desc, eq, asc } from 'drizzle-orm';
import { dec, type Dec } from '@/lib/calc/decimal';
import { buildRuleSet, type RuleRow } from '@/lib/calc/rules';
import type { Moment } from '@/lib/calc/time';
import type { DashboardInput, EntityInput, MonthFact, Selections } from '@/lib/calc/types';
import type { Db } from './client';
import { legalEntities, rateChoices, revenueMonthly, rules, seasonality } from './schema';

/**
 * Собирает вход калькулятора из базы: сущности, веса, правила на дату, факты месяцев и выбранные ставки.
 * Единственное место, где строки numeric превращаются в Decimal.
 */
export async function loadDashboardInput(db: Db, now: Moment): Promise<DashboardInput> {
  const [ruleRows, weightRows, entityRows, monthlyRows, choiceRows] = await Promise.all([
    db.select().from(rules),
    db.select().from(seasonality).orderBy(asc(seasonality.month)),
    db.select().from(legalEntities).orderBy(asc(legalEntities.sort), asc(legalEntities.id)),
    db.select().from(revenueMonthly).where(eq(revenueMonthly.year, now.year)),
    db
      .select()
      .from(rateChoices)
      .where(eq(rateChoices.year, now.year))
      .orderBy(desc(rateChoices.chosenAt), desc(rateChoices.id)),
  ]);

  if (weightRows.length !== 12) {
    throw new Error('Справочник seasonality должен содержать 12 месяцев');
  }
  const weights: Dec[] = weightRows.map((w) => dec(w.weight));
  const total = weights.reduce((a, b) => a.plus(b), dec(0));
  if (total.minus(1).abs().gt('0.0001')) {
    throw new Error(`Сумма весов сезонности ${total.toString()}, ожидается 1`);
  }

  const byEntity = new Map<string, MonthFact[]>();
  for (const m of monthlyRows) {
    const list = byEntity.get(m.entityId) ?? [];
    list.push({ month: m.month - 1, amount: dec(m.amount), isFact: m.isFact });
    byEntity.set(m.entityId, list);
  }

  const entities: EntityInput[] = entityRows.map((r) => ({
    id: r.id,
    name: r.name,
    form: r.form,
    ownerLabel: r.ownerLabel,
    status: r.vatStatus === 'exempt' ? 'exempt' : 'payer',
    annualRevenue: dec(r.annualRevenue),
    inputVatShare: dec(r.inputVatShare),
    color: r.color,
    description: r.description ?? '',
    taxRegime:
      r.taxRegime === 'osno' || r.taxRegime === 'usn_income_expense' ? r.taxRegime : 'usn_income',
    usnRate: r.usnRate === null ? null : dec(r.usnRate),
    annualExpenses: dec(r.annualExpenses),
    monthly: byEntity.get(r.id) ?? [],
  }));

  const selections: Selections = {};
  for (const c of choiceRows) {
    if (selections[c.entityId] === undefined) selections[c.entityId] = c.rate;
  }

  const ruleInput: RuleRow[] = ruleRows.map((r) => ({
    key: r.key,
    value: r.value,
    formula: r.formula,
    unit: r.unit,
    validFrom: r.validFrom,
    validTo: r.validTo,
    norm: r.norm,
    sourceUrl: r.sourceUrl,
    note: r.note,
  }));

  return { entities, selections, ctx: { weights, rules: buildRuleSet(ruleInput, now) } };
}

export async function saveRateChoice(
  db: Db,
  args: { entityId: string; year: number; rate: number; userId: string },
): Promise<void> {
  await db.insert(rateChoices).values({
    entityId: args.entityId,
    year: args.year,
    rate: args.rate,
    chosenBy: args.userId,
  });
}

export async function entityExists(db: Db, entityId: string): Promise<boolean> {
  const rows = await db
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(and(eq(legalEntities.id, entityId)))
    .limit(1);
  return rows.length > 0;
}

/** Режим налогообложения юрлица или null, если юрлица нет. */
export async function entityTaxRegime(db: Db, entityId: string): Promise<string | null> {
  const rows = await db
    .select({ regime: legalEntities.taxRegime })
    .from(legalEntities)
    .where(eq(legalEntities.id, entityId))
    .limit(1);
  return rows[0]?.regime ?? null;
}
