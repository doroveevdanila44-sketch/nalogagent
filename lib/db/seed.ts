import { sql } from 'drizzle-orm';
import {
  SEED_ENTITIES,
  SEED_RULE_ROWS,
  SEED_SOURCE,
  SEED_WEIGHTS,
  seedRevenueRows,
} from '@/lib/calc/demo-data';
import { epochFromWallClock } from '@/lib/calc/time';
import { getEnv } from '@/lib/env';
import type { Db } from './client';
import { TEMPLATES } from '@/lib/documents/templates';
import type { EntityRequisites } from '@/lib/documents/types';
import { dataSources, documentTemplates, legalEntities, people, revenueMonthly, rules, seasonality } from './schema';

/**
 * Сид выдуманных данных демо. Детерминирован (не зависит от часов) и идемпотентен:
 *  - один источник data_sources «Выгрузка из 1С (демо)», дата загрузки 10 октября 2026, 18:00
 *    по часовому поясу приложения; повторный запуск возвращает эти значения;
 *  - помесячная выручка пяти юрлиц за 2025 и 2026 годы со ссылкой на источник: факт по сентябрь
 *    2026 включительно, октябрь идёт, ноябрь и декабрь прогноз (признак факта не зависит от даты);
 *  - правила и веса вставляются, существующие записи не трогаются, чтобы правка владельца
 *    (например, дефлятор) не затиралась повторным запуском;
 *  - юрлица демо вставляются и ОБНОВЛЯЮТСЯ (название, цифры, режим налогообложения): сид
 *    приводит демо-данные к описанным в CALC.md.
 *  - справочник people для «Отправить на проверку»: три вымышленных получателя, имена выдуманы,
 *    настоящих людей и адресов нет; повторный запуск приводит записи к этому списку.
 * Пользователь luxautoowner сидом не создаётся, только командой npm run user:create.
 */

/** Вымышленный справочник получателей (демо). Фамилии нарочно «образцовые». */
export const SEED_PEOPLE = [
  { id: 'demo-accountant', name: 'Елена Образцова', role: 'Бухгалтер', sort: 1 },
  { id: 'demo-cfo', name: 'Сергей Примеров', role: 'Финансовый директор', sort: 2 },
  { id: 'demo-consultant', name: 'Анна Шаблонова', role: 'Налоговый консультант', sort: 3 },
] as const;
export interface SeedOptions {
  /** Часовой пояс, в котором задана дата загрузки; по умолчанию APP_TZ */
  tz?: string;
  /** Прежний вызов передавал текущий год и месяц. Сид больше не зависит от даты, поля игнорируются */
  year?: number;
  month?: number;
}

/**
 * Реквизиты юрлиц для документов. Все выдуманы и помечены demo: ИНН и ОГРН с кодом региона 99
 * (такого региона нет), счета и БИК условные, адреса и фамилии правдоподобные, но вымышленные.
 * Единственное место, где они заведены: договоры и допсоглашения берут их из справочника юрлица.
 * Настоящих реквизитов клиента здесь нет.
 */
export const SEED_REQUISITES: Record<string, EntityRequisites> = {
  alfa: {
    inn: '9900000011', kpp: '990001001', ogrn: '1999900000011',
    address: 'г. Петропавловск-Камчатский, ул. Ленинградская, д. 24, офис 3',
    signerName: 'Воробьёв Игорь Сергеевич', signerPosition: 'генеральный директор',
    bank: 'Банк «Авачинский»', bik: '049999991', account: '40702810000000000011', corrAccount: '30101810000000000991',
    email: 'alfa@example.invalid', phone: '+7 000 000-00-11', demo: true,
  },
  beta: {
    inn: '990000000022', ogrn: '399990000000022',
    address: 'г. Петропавловск-Камчатский, ул. Королёва, д. 11',
    signerName: 'Громов Андрей Павлович', signerPosition: 'индивидуальный предприниматель',
    bank: 'Банк «Авачинский»', bik: '049999991', account: '40802810000000000022', corrAccount: '30101810000000000991',
    email: 'beta@example.invalid', phone: '+7 000 000-00-22', demo: true,
  },
  delta: {
    inn: '990000000033', ogrn: '399990000000033',
    address: 'г. Петропавловск-Камчатский, ул. Ларина, д. 15',
    signerName: 'Исаев Максим Олегович', signerPosition: 'индивидуальный предприниматель',
    bank: 'Банк «Авачинский»', bik: '049999991', account: '40802810000000000033', corrAccount: '30101810000000000991',
    email: 'delta@example.invalid', phone: '+7 000 000-00-33', demo: true,
  },
  gamma: {
    inn: '9900000044', kpp: '990001001', ogrn: '1999900000044',
    address: 'г. Петропавловск-Камчатский, пр. Карла Маркса, д. 7, офис 12',
    signerName: 'Ковалёва Мария Викторовна', signerPosition: 'директор',
    bank: 'Банк «Авачинский»', bik: '049999991', account: '40702810000000000044', corrAccount: '30101810000000000991',
    email: 'gamma@example.invalid', phone: '+7 000 000-00-44', demo: true,
  },
  epsilon: {
    inn: '9900000055', kpp: '990001001', ogrn: '1999900000055',
    address: 'г. Петропавловск-Камчатский, ул. Тушканова, д. 8, офис 5',
    signerName: 'Назаров Антон Викторович', signerPosition: 'генеральный директор',
    bank: 'Банк «Авачинский»', bik: '049999991', account: '40702810000000000055', corrAccount: '30101810000000000991',
    email: 'epsilon@example.invalid', phone: '+7 000 000-00-55', demo: true,
  },
};

export async function seedDatabase(db: Db, opts: SeedOptions = {}): Promise<void> {
  const tz = opts.tz ?? getEnv().appTz;
  const at = SEED_SOURCE.loadedAt;
  const loadedAt = new Date(epochFromWallClock(tz, at.year, at.month, at.day, at.hour, at.minute));

  await db
    .insert(dataSources)
    .values({
      id: SEED_SOURCE.id,
      kind: SEED_SOURCE.kind,
      title: SEED_SOURCE.title,
      isDemo: SEED_SOURCE.isDemo,
      loadedAt,
    })
    .onConflictDoUpdate({
      target: dataSources.id,
      set: {
        kind: sql`excluded.kind`,
        title: sql`excluded.title`,
        isDemo: sql`excluded.is_demo`,
        loadedAt: sql`excluded.loaded_at`,
      },
    });

  // каталог шаблонов документов: образцы, юридически не проверены
  await db
    .insert(documentTemplates)
    .values(
      TEMPLATES.map((t) => ({
        key: t.key,
        category: t.category,
        title: t.title,
        description: t.description,
        body: t.body,
        fields: t.fields,
        scope: t.scope,
        needsPeriod: t.needsPeriod,
        output: t.output,
        taxes: t.taxes,
        sort: t.sort,
      })),
    )
    .onConflictDoUpdate({
      target: documentTemplates.key,
      set: {
        category: sql`excluded.category`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        body: sql`excluded.body`,
        fields: sql`excluded.fields`,
        scope: sql`excluded.scope`,
        needsPeriod: sql`excluded.needs_period`,
        output: sql`excluded.output`,
        taxes: sql`excluded.taxes`,
        sort: sql`excluded.sort`,
      },
    });

  await db
    .insert(people)
    .values(SEED_PEOPLE.map((p) => ({ ...p })))
    .onConflictDoUpdate({
      target: people.id,
      set: { name: sql`excluded.name`, role: sql`excluded.role`, sort: sql`excluded.sort` },
    });

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
        requisites: SEED_REQUISITES[e.id] ?? null,
        revenuePerCarMonthly: e.revenuePerCarMonthly ? e.revenuePerCarMonthly.toFixed(2) : null,
        activity: e.activity ?? null,
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
        requisites: sql`excluded.requisites`,
        revenuePerCarMonthly: sql`excluded.revenue_per_car_monthly`,
        activity: sql`excluded.activity`,
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

  await db
    .insert(revenueMonthly)
    .values(
      seedRevenueRows().map((r) => ({
        entityId: r.entityId,
        year: r.year,
        month: r.month,
        amount: r.amount.toFixed(2),
        isFact: r.isFact,
        sourceId: SEED_SOURCE.id,
        updatedAt: loadedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [revenueMonthly.entityId, revenueMonthly.year, revenueMonthly.month],
      set: {
        amount: sql`excluded.amount`,
        isFact: sql`excluded.is_fact`,
        sourceId: sql`excluded.source_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}
