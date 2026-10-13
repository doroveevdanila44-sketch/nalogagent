import { and, desc, eq, asc } from 'drizzle-orm';
import { dec } from '@/lib/calc/decimal';
import { sourceRef } from '@/lib/calc/provenance';
import type { RuleRow } from '@/lib/calc/rules';
import { buildCalcData, dashboardInput, type CalcData, type RevenueRow } from '@/lib/calc/service';
import type { Moment } from '@/lib/calc/time';
import type { DashboardInput, EntityInput, Selections } from '@/lib/calc/types';
import type { Db } from './client';
import { dataSources, legalEntities, rateChoices, revenueMonthly, rules, seasonality } from './schema';

/** Описание юрлица без слова «демо»: метка «Демо-данные» одна, в шапке. Заведённое прежним сидом заменяется. */
function cleanDescription(raw: string | null): string {
  const text = raw ?? '';
  return /демо/i.test(text) ? 'Условное юрлицо на ОСНО' : text;
}

/**
 * Снимок данных для расчётного сервиса: юрлица, веса, правила, помесячная выручка всех лет,
 * выбранные ставки по годам и источник. Единственное место, где строки numeric превращаются
 * в Decimal; все цифры дашборда, чата, документов и выгрузок идут отсюда.
 */
export async function loadCalcData(db: Db, today: Moment): Promise<CalcData> {
  const [ruleRows, weightRows, entityRows, revenueRows, choiceRows, sourceRows] = await Promise.all([
    db.select().from(rules),
    db.select().from(seasonality).orderBy(asc(seasonality.month)),
    db.select().from(legalEntities).orderBy(asc(legalEntities.sort), asc(legalEntities.id)),
    db.select().from(revenueMonthly),
    db.select().from(rateChoices).orderBy(desc(rateChoices.chosenAt), desc(rateChoices.id)),
    db.select().from(dataSources).orderBy(desc(dataSources.loadedAt), desc(dataSources.id)).limit(1),
  ]);

  const entities: Omit<EntityInput, 'monthly'>[] = entityRows.map((r) => ({
    id: r.id,
    name: r.name,
    form: r.form,
    ownerLabel: r.ownerLabel,
    status: r.vatStatus === 'exempt' ? 'exempt' : 'payer',
    annualRevenue: dec(r.annualRevenue),
    inputVatShare: dec(r.inputVatShare),
    color: r.color,
    description: cleanDescription(r.description),
    taxRegime:
      r.taxRegime === 'osno' || r.taxRegime === 'usn_income_expense' ? r.taxRegime : 'usn_income',
    usnRate: r.usnRate === null ? null : dec(r.usnRate),
    annualExpenses: dec(r.annualExpenses),
  }));

  // записи отсортированы от новых к старым: действует первая по юрлицу и году
  const choices: Record<number, Selections> = {};
  for (const c of choiceRows) {
    const year = (choices[c.year] ??= {});
    if (year[c.entityId] === undefined) year[c.entityId] = c.rate;
  }

  const revenue: RevenueRow[] = revenueRows.map((r) => ({
    entityId: r.entityId,
    year: r.year,
    month: r.month,
    amount: dec(r.amount),
    isFact: r.isFact,
    sourceId: r.sourceId,
    updatedAt: r.updatedAt.toISOString(),
  }));

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

  const source = sourceRows[0] ? sourceRef(sourceRows[0]) : null;

  return buildCalcData({
    today,
    entities,
    weights: weightRows.map((w) => dec(w.weight)),
    ruleRows: ruleInput,
    choices,
    revenue,
    source,
  });
}

/**
 * Вход дашборда и чата на момент `now`: тот же снимок, что у расчётного сервиса, правила на
 * сегодня и выбранные ставки текущего года. Бросает MissingRuleError, если правил на дату нет.
 */
export async function loadDashboardInput(db: Db, now: Moment): Promise<DashboardInput> {
  return dashboardInput(await loadCalcData(db, now));
}

/**
 * Запись выбора ставки в rate_choices с историей. В интерфейсе выбор не меняется: выбранная ставка
 * берётся из таблицы (сид, консоль базы, тесты), нажатием на карточку ставки её не сменить.
 */
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
