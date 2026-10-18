import {
  MONTH_NAMES,
  dec,
  fleetSoftWarnings,
  fleetUnitPrices,
  numText,
  pluralRu,
  rub,
  sourceLine,
  type CarsRequest,
  type FleetEffect,
  type WhatIfComparison,
} from '@/lib/calc';
import {
  amountWord,
  diffText,
  entityTable,
  incomeTaxWord,
  limitLine,
  money,
  pairLine,
  summaryTable,
  thresholdLine,
  toWhatIfSnapshot,
  unifiedLine,
  verdictLine,
  type WhatIfSnapshot,
} from '@/lib/provenance/whatif';
import { narrowChoices } from './clarify';
import { isoToRu, ruleLine, type AnswerCalc, type TaxAnswerContext } from './tax-answer';
import type { CalcResult, EntityRef, QuickReply, Table, Understanding } from './types';

/**
 * Ответ на «что если»: слова вокруг результата compareWhatIf (lib/calc/whatif.ts). Все числа
 * приходят из расчёта через WhatIfSnapshot, здесь только подстановка в фразы. Пометка «Сценарий,
 * а не прогноз» и список допущений стоят в самом ответе, без раскрытия.
 */

export interface WhatIfAnswer {
  result: CalcResult;
  scope: string[] | 'all';
  calcs: AnswerCalc[];
  card: Understanding;
  quick: QuickReply[];
  snapshot: WhatIfSnapshot;
}

const BULLET = '• ';

const paybackCell = (v: FleetEffect['paybackMonths']) => (v === null ? 'не окупается' : `${v.toFixed(1).replace('.', ',')} мес.`);

/** Разбивка по машинам, когда они различаются: стоимость, цена сдачи, выручка, вычет, окупаемость и итог. */
function breakdownTable(f: FleetEffect): Table {
  const applied = f.deduction === 'applied';
  const rows = f.units.map((u) => [
    `Машина ${u.index + 1}`,
    rub(u.cost),
    rub(u.rentPerDay),
    rub(u.perMonth),
    applied ? rub(u.inputVat) : 'нет',
    paybackCell(u.paybackMonths),
  ]);
  rows.push(['Вместе', rub(f.totalCost), '', rub(f.perMonth), applied ? rub(f.deducted) : 'нет', paybackCell(f.paybackMonths)]);
  return {
    head: ['Машина', 'Стоимость', 'Сдача в сутки', 'Выручка в месяц', 'Вычет НДС', 'Окупаемость'],
    rows,
    totalRow: true,
    dense: true,
  };
}

/** Кто затронут, в фразе «у …»: «у ИП Дельта», «у группы». */
function whoOf(cmp: WhatIfComparison): string {
  if (cmp.spec.entityIds === 'all') return 'у группы';
  return `у ${cmp.rows.map((r) => r.name).join(' и ')}`;
}

function headline(cmp: WhatIfComparison): string {
  const r = cmp.spec.request;
  const months = cmp.monthsLabel;
  const who = whoOf(cmp);
  switch (r.kind) {
    case 'cars': {
      const c = cmp.changes[0]!;
      const n = r.cars ?? 0;
      const label = `${n} ${pluralRu(n, 'машину', 'машины', 'машин')}`;
      const name = cmp.rows[0]!.name;
      return months
        ? `${name} покупает ${label}, добавочная выручка ${rub(c.perMonth!)} в месяц (${months})`
        : `${name} покупает ${label}, но до конца года месяцев не осталось`;
    }
    case 'growth':
      return `${who} выручка прогнозных месяцев (${months}) ${r.percent >= 0 ? 'вырастет' : 'упадёт'} на ${numText(Math.abs(r.percent))}%`;
    case 'amount':
      return `${who} выручка прогнозных месяцев (${months}) ${r.amount >= 0 ? 'вырастет' : 'упадёт'} на ${amountWord(r.amount)}`;
  }
}

/** Карточка «Понял так»: юрлицо, что меняется, на какие месяцы. */
function cardOf(cmp: WhatIfComparison): Understanding {
  const r = cmp.spec.request;
  const what =
    r.kind === 'cars'
      ? `+${r.cars ?? 0} ${pluralRu(r.cars ?? 0, 'машина', 'машины', 'машин')}`
      : r.kind === 'growth'
        ? `${r.percent >= 0 ? '+' : '−'}${numText(Math.abs(r.percent))}% к выручке`
        : `${r.amount >= 0 ? '+' : '−'}${amountWord(r.amount)} к выручке`;
  return {
    entity: cmp.spec.entityIds === 'all' ? 'Вся группа' : cmp.rows.map((r) => r.name).join(' и '),
    tax: what,
    period: cmp.monthsLabel || `${MONTH_NAMES[11]} ${cmp.year}`,
    kind: 'forecast',
    kindLabel: 'сценарий',
    notes: [],
  };
}

/** Кнопки под ответом: другое значение того же условия и сужение до юрлица. */
function quickOf(cmp: WhatIfComparison, entities: EntityRef[]): QuickReply[] {
  const r = cmp.spec.request;
  const out: QuickReply[] = [];
  if (r.kind === 'growth') {
    const opts: [number, string, string][] = [
      [10, 'Рост +10%', 'а если выручка вырастет на 10%'],
      [20, 'Рост +20%', 'а если выручка вырастет на 20%'],
      [-10, 'Падение −10%', 'а если выручка упадёт на 10%'],
    ];
    for (const [p, label, text] of opts) if (p !== r.percent) out.push({ label, text });
  } else if (r.kind === 'cars') {
    const opts: [number, string][] = [
      [3, 'а если купим 3 машины'],
      [10, 'а если купим 10 машин'],
    ];
    for (const [n, text] of opts) {
      if (n !== r.cars) out.push({ label: `${n} ${pluralRu(n, 'машина', 'машины', 'машин')}`, text });
    }
  } else {
    const opts: [number, string, string][] = [
      [1_000_000, '+1 млн', 'а если выручка вырастет на 1 млн'],
      [3_000_000, '+3 млн', 'а если выручка вырастет на 3 млн'],
    ];
    for (const [a, label, text] of opts) if (a !== r.amount) out.push({ label, text });
  }
  out.push(...narrowChoices(entities));
  return out;
}

/** Формулы для блока «Как посчитано»: сценарные шаги, налог года, правила, источник. */
function howOf(cmp: WhatIfComparison, snap: WhatIfSnapshot, c: TaxAnswerContext): string[] {
  const lines: string[] = [];
  if (cmp.fleet) {
    const l = cmp.fleet.lines;
    lines.push(`${cmp.fleet.name}, парк машин: ${l.values}`, l.deduction, l.expenses, l.payback);
    if (l.notModeled) lines.push(l.notModeled);
  }
  for (const row of snap.rows) {
    lines.push(`${row.name}, выручка за год: ${money(row.revenue.base)} → ${money(row.revenue.scenario)}`);
  }
  for (const run of cmp.scenario) {
    for (const e of run.entities) {
      if (!e.applicable) continue;
      const own = run.steps.filter((s) => s.entityId === e.entityId);
      const totals = new Set([e.taxStep, e.revenueStep]);
      // шаги выручки месяцев, которые изменил сценарий (только у НДС: те же месяцы у налога с доходов)
      if (run.tax === 'vat') {
        for (const s of own) {
          if (s.month !== null && s.text.startsWith('по сценарию') && !/без изменений/.test(s.text)) {
            lines.push(`${s.label}: ${s.text}`);
          }
        }
      }
      // налог года по формулам: доходы без НДС, база, ставка
      for (const s of own) {
        if (s.month === null && !totals.has(s.id)) lines.push(`${s.label}: ${s.text}`);
      }
      const tail = own.find((s) => s.id === e.taxStep);
      if (tail) lines.push(`${e.name}, ${run.taxName} по сценарию: ${tail.text}`);
    }
  }
  for (const run of cmp.base) {
    for (const e of run.entities) {
      if (!e.applicable) continue;
      const tail = run.steps.find((s) => s.id === e.taxStep);
      if (tail) lines.push(`${e.name}, ${run.taxName} сейчас: ${tail.text}`);
    }
  }
  const rules = new Map<string, string>();
  for (const run of [...cmp.base, ...cmp.scenario]) {
    for (const x of run.rules) rules.set(`${x.key}|${x.validFrom}`, `Правило: ${ruleLine(x)}`);
  }
  lines.push(...rules.values());
  const first = cmp.scenario[0];
  if (first?.source) lines.push(`Источник: ${sourceLine(first.source, c.tz)}`);
  if (first) lines.push(`Расчёт на ${isoToRu(first.asOf)}`);
  return lines;
}

export function buildWhatIfAnswer(c: TaxAnswerContext, cmp: WhatIfComparison, entities: EntityRef[]): WhatIfAnswer {
  const snap = toWhatIfSnapshot(cmp);
  const year = cmp.year;
  const t = snap.totals;
  const paragraphs: string[] = [];

  const fleet = cmp.fleet;
  if (fleet) {
    // принятые значения одной строкой вверху, затем кто покупает и что это даёт по месяцам
    paragraphs.push(`Сценарий, а не прогноз: ${fleet.lines.values}.`);
    paragraphs.push(`${headline(cmp)}.`);
    // необычные значения не блокируют расчёт, но их стоит перепроверить
    const soft = fleetSoftWarnings(fleetUnitPrices(cmp.spec.request as CarsRequest));
    if (soft.length > 0) paragraphs.push(`Проверьте значения: ${soft.join('; ')}.`);
  } else {
    paragraphs.push(`Сценарий, а не прогноз: ${headline(cmp)}.`);
  }

  if (cmp.noChange) {
    paragraphs.push(
      cmp.spec.request.kind === 'cars'
        ? `До конца ${year} года месяцев, в которых машины дали бы выручку, не осталось: расчёт не меняется.`
        : 'Изменений выручки нет: цифры совпадают с расчётом по данным.',
    );
  }

  const incomeLabel = `${incomeTaxWord(snap.rows).replace(/^./, (x) => x.toUpperCase())} за год`;
  paragraphs.push(
    `Новый прогноз года: выручка ${money(t.revenue.scenario)} (было ${money(t.revenue.base)}, ${diffText(t.revenue)}). ` +
      `${pairLine('НДС за год', t.vat)}. ${pairLine(incomeLabel, t.incomeTax)}.`,
  );
  // вычет по машинам может увести НДС года ниже нуля: это возмещение, а не налог к уплате
  if (fleet && t.vat.scenario !== null && dec(t.vat.scenario).isNegative()) {
    paragraphs.push('НДС за год получился отрицательным: это НДС к возмещению из бюджета, а не налог к уплате.');
  }

  // порог освобождения у освобождённых юрлиц: главный эффект сценария
  for (const r of snap.rows) {
    const line = thresholdLine(r, year);
    if (line) paragraphs.push(line);
  }
  const limit = limitLine(snap.rows);
  if (limit) paragraphs.push(limit);

  // машины: вычет входного НДС, расходы, чего ядро не считает, окупаемость
  const shown = new Set<string>();
  if (fleet) {
    const l = fleet.lines;
    for (const line of [l.deduction, l.expenses, l.notModeled, l.payback]) {
      if (!line) continue;
      shown.add(line);
      paragraphs.push(`${line}.`);
    }
  }

  const verdict = verdictLine(snap);
  if (verdict) paragraphs.push(verdict);

  const unified = unifiedLine(snap);
  if (unified) paragraphs.push(unified);

  const rest = cmp.assumptions.filter((a) => !shown.has(a));
  paragraphs.push(`Допущения:\n${rest.map((a) => `${BULLET}${a}.`).join('\n')}`);

  const tables: Table[] = [summaryTable(snap)];
  // машины различаются: разбивка по каждой
  if (fleet && !fleet.effect.uniform) tables.push(breakdownTable(fleet.effect));
  const byEntity = entityTable(snap);
  if (byEntity) tables.push(byEntity);

  const asked: string[] | 'all' = cmp.spec.entityIds === 'all' ? 'all' : cmp.spec.entityIds;
  const calcs: AnswerCalc[] = [];
  const pairs = Math.max(cmp.base.length, cmp.scenario.length);
  for (let i = 0; i < pairs; i++) {
    if (cmp.base[i]) calcs.push({ result: cmp.base[i]!, scope: asked });
    if (cmp.scenario[i]) calcs.push({ result: cmp.scenario[i]!, scope: asked });
  }
  // сравнение хранится один раз, на первом расчёте: по нему панель и Excel строят таблицу
  if (calcs[0]) calcs[0] = { ...calcs[0], comparison: snap };

  const only = cmp.rows.length === 1 ? cmp.rows[0]!.entityId : null;
  return {
    result: { intent: 'whatif', paragraphs, tables, how: howOf(cmp, snap, c), entityId: only },
    scope: cmp.rows.map((r) => r.entityId),
    calcs,
    card: cardOf(cmp),
    quick: quickOf(cmp, entities),
    snapshot: snap,
  };
}
