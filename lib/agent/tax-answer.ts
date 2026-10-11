import {
  MONTH_NAMES,
  REGIME_LABEL,
  ZERO,
  calcTax,
  dateRu,
  dateRuYear,
  formatPeriodFor,
  groupPayments,
  incomeTaxRate,
  incomeTaxSchedule,
  mln,
  nextPayment,
  periodKindOf,
  rub,
  sourceLine,
  sum,
  type CalcData,
  type CalcResult as TaxCalc,
  type DashboardInput,
  type Dec,
  type EntityInput,
  type Moment,
  type PeriodKind,
  type MonthStatus,
  type RuleRef,
} from '@/lib/calc';
import type { CalcResult, Interpretation, Table } from './types';

/**
 * Ответ «сколько налога за период»: все числа из calcTax для понятого периода. Текст только
 * подставляет их в слова. Период берётся из вопроса: за февраль выдаётся февраль, за квартал
 * квартал, годовой прогноз только на вопрос про год.
 */
export interface TaxAnswerContext {
  data: CalcData;
  input: DashboardInput;
  now: Moment;
  /** Часовой пояс приложения: для времени загрузки источника */
  tz: string;
  /** Строка «Что могу сейчас», если расчёт не удался из-за правил или данных */
  canDo: string;
}

/** Расчёт, на котором стоит ответ: по нему панель «Показать расчёт» и Excel показывают те же цифры. */
export interface AnswerCalc {
  result: TaxCalc;
  /** Юрлица вопроса: 'all' для группы целиком */
  scope: string[] | 'all';
}

export interface TaxAnswer {
  result: CalcResult;
  kind: PeriodKind;
  /** Юрлица, по которым посчитано */
  scope: string[];
  /** Расчёты calcTax, из которых собран ответ */
  calcs: AnswerCalc[];
}

const VAT_THIRD = ['первая треть', 'вторая треть', 'третья треть'] as const;

const RULE_TITLE: Record<string, string> = {
  rate_special_5: 'Ставка НДС 5%',
  rate_special_7: 'Ставка НДС 7%',
  rate_general: 'Общая ставка НДС',
  vat_exempt_limit: 'Порог освобождения от НДС',
  usn_rate_income: 'Ставка УСН «доходы»',
  usn_rate_income_expense: 'Ставка УСН «доходы минус расходы»',
  usn_min_tax_rate: 'Минимальный налог УСН',
  profit_tax_rate: 'Ставка налога на прибыль',
};

const mln2 = (d: Dec) => mln(d, 2);

/** «Вся группа», если в вопросе названы все юрлица, иначе список. */
function askedScope(c: TaxAnswerContext, scope: string[]): string[] | 'all' {
  return scope.length === c.data.entities.length ? 'all' : scope;
}

function isoToRu(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return dateRuYear({ year: y, month: m - 1, day: d });
}

function ruleLine(r: RuleRef): string {
  const title = RULE_TITLE[r.key] ?? r.key;
  let value = '';
  if (r.value !== null) {
    const n = Number(r.value);
    value = r.unit === 'percent' ? `${n}%` : r.unit === 'rub' ? mln(n, 0) : `${n}`;
  }
  const parts = [title + (value ? ` ${value}` : ''), r.norm, `действует с ${isoToRu(r.validFrom)}`];
  return parts.filter(Boolean).join(', ');
}

/** «по ООО «Альфа» и ИП Бета» или «по группе». */
function scopeText(i: Interpretation, names: Map<string, string>): string {
  if (i.entityMode === 'named') {
    const list = i.entities.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
    if (list.length > 0) return ` по ${list.join(' и ')}`;
  }
  return ' по группе';
}

/** Период в фразе: «за год» для текущего года, иначе «за февраль 2026». */
function periodPhrase(i: Interpretation, today: Moment): string {
  const p = i.period!;
  if (p.kind === 'year' && p.year === today.year) return 'за год';
  return formatPeriodFor(p);
}

function statusesOf(...results: (TaxCalc | null)[]): MonthStatus[] {
  const out: MonthStatus[] = [];
  for (const r of results) {
    if (!r) continue;
    for (const e of r.entities) for (const m of e.months) out.push(m.status);
  }
  return out;
}

/** «Факт по сентябрь включительно, октябрь идёт, дальше прогноз.» из месяцев результата. */
function kindSentence(months: { month: number; status: MonthStatus }[], kind: PeriodKind): string {
  if (kind === 'fact') return 'Все месяцы периода по факту.';
  if (kind === 'forecast') return 'Весь период это прогноз.';
  const lastFact = [...months].reverse().find((m) => m.status === 'fact');
  const partial = months.find((m) => m.status === 'partial');
  const hasForecast = months.some((m) => m.status === 'forecast');
  const parts: string[] = [];
  if (lastFact) parts.push(`факт по ${MONTH_NAMES[lastFact.month - 1]} включительно`);
  if (partial) parts.push(`${MONTH_NAMES[partial.month - 1]} идёт`);
  if (hasForecast) parts.push('дальше прогноз');
  if (parts.length === 0) return 'Часть периода факт, часть прогноз.';
  const s = parts.join(', ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function basisWord(s: MonthStatus): string {
  return s === 'fact' ? 'факт' : s === 'partial' ? 'идёт' : 'прогноз';
}

function monthTable(r: TaxCalc, head: string): Table | null {
  if (r.months.length < 2 || r.months.length > 6 || r.months.some((m) => m.tax === null)) return null;
  const rows = r.months.map((m) => [m.label, mln2(m.tax!), basisWord(m.status)]);
  rows.push(['Всего', r.total ? mln2(r.total) : '', '']);
  return { head: ['Месяц', head, 'Основа'], rows, totalRow: true };
}

export function paymentLines(
  c: TaxAnswerContext,
  kinds: ('vat' | 'usn' | 'profit')[],
  scopeIds: string[],
): string | null {
  const { selections, ctx } = c.input;
  const ents = c.input.entities.filter((e) => scopeIds.includes(e.id));
  const list = groupPayments(ents, selections, ctx, c.now).filter((p) => kinds.includes(p.kind));
  const first = list[0];
  if (!first) return null;
  const same = list.filter(
    (p) => p.due.year === first.due.year && p.due.month === first.due.month && p.due.day === first.due.day,
  );
  if (first.kind === 'vat') {
    const total = sum(same.filter((p) => p.kind === 'vat').map((p) => p.amount));
    const third = VAT_THIRD[(first.vatThird ?? 1) - 1];
    return `Ближайший платёж по НДС ${dateRu(first.due)}: ${third} за ${first.vatQuarter} квартал, ${rub(total)}.`;
  }
  const usn = sum(same.filter((p) => p.kind === 'usn').map((p) => p.amount));
  const profit = sum(same.filter((p) => p.kind === 'profit').map((p) => p.amount));
  const parts = [
    usn.gt(0) ? `по УСН ${rub(usn)}` : null,
    profit.gt(0) ? `по налогу на прибыль ${rub(profit)}` : null,
  ].filter((x): x is string => x !== null);
  const when = first.final ? `${dateRu(first.due)} ${first.due.year}` : dateRu(first.due);
  return `Ближайший срок ${when}: ${first.final ? 'итоговая уплата' : 'авансовые платежи'} ${first.periodLabel}, ${parts.join(' и ')}.`;
}

/** Шаги формул для блока «Как посчитано». Помесячные только для коротких периодов. */
function howLines(results: TaxCalc[], c: TaxAnswerContext): string[] {
  const lines: string[] = [];
  const names = new Map(c.input.entities.map((e) => [e.id, e.name]));
  for (const r of results) {
    for (const e of r.entities) {
      if (!e.applicable) continue;
      const own = r.steps.filter((s) => s.entityId === e.entityId);
      const totals = new Set([e.taxStep, e.revenueStep]);
      // расчёт налога года (доходы без НДС, база, ставка)
      for (const s of own) {
        if (s.month === null && !totals.has(s.id)) lines.push(`${s.label}: ${s.text}`);
      }
      // помесячные формулы: только когда месяцев немного
      if (e.months.length <= 3) {
        for (const s of own) {
          if (s.month === null) continue;
          const isRevenue = e.months.some((m) => m.revenueStep === s.id);
          if (isRevenue && !/^прогноз|×/.test(s.text)) continue;
          lines.push(`${s.label}: ${s.text}`);
        }
      }
      if (e.taxStep) {
        const tail = own.find((s) => s.id === e.taxStep);
        if (tail) lines.push(`${names.get(e.entityId) ?? e.name}: ${tail.text}`);
      }
    }
  }
  const first = results[0];
  if (first) {
    const rules = new Map<string, RuleRef>();
    for (const r of results) for (const x of r.rules) rules.set(`${x.key}|${x.validFrom}`, x);
    for (const x of rules.values()) lines.push(`Правило: ${ruleLine(x)}`);
    if (first.source) lines.push(`Источник: ${sourceLine(first.source, c.tz)}`);
    lines.push(`Расчёт на ${isoToRu(first.asOf)}`);
  }
  return lines;
}

function exemptEntities(r: TaxCalc): string[] {
  return r.entities
    .filter((e) => e.applicable && e.months.length > 0 && e.months.every((m) => m.exempt))
    .map((e) => e.name);
}

// ===== НДС =====

function vatAnswer(c: TaxAnswerContext, i: Interpretation, scope: string[], names: Map<string, string>): TaxAnswer {
  const r = calcTax(
    { entityIds: scope.length === c.data.entities.length ? 'all' : scope, tax: 'vat', period: i.period!, rate: i.rate ?? undefined },
    c.data,
  );
  const kind = periodKindOf(statusesOf(r));
  const phrase = periodPhrase(i, c.now);
  const where = scopeText(i, names);
  const paragraphs: string[] = [];
  // числа и даты из примечаний расчёта и графика платежей дублируются в «Как посчитано»
  const evidence: string[] = [];

  if (r.total === null) {
    paragraphs.push(`НДС ${phrase}${where} не рассчитан.`);
    for (const w of r.warnings.filter((x) => x.kind === 'no_rules' || x.kind === 'no_data')) paragraphs.push(w.text);
    if (r.revenue !== null) paragraphs.push(`Выручка с НДС за период ${mln2(r.revenue)}.`);
    paragraphs.push(c.canDo);
  } else {
    const rateNote = i.rate ? ` по ставке ${i.rate}%` : '';
    paragraphs.push(`НДС ${phrase}${where}${rateNote}: ${mln2(r.total)}.`);
    const monthsOf = (r.entities.find((e) => e.applicable)?.months ?? []).map((m) => ({ month: m.month, status: m.status }));
    paragraphs.push(kindSentence(monthsOf, kind));
    const exempt = exemptEntities(r);
    if (exempt.length > 0) {
      paragraphs.push(`Освобождены от НДС и за этот период не платят: ${exempt.join(', ')}.`);
    }
    // порог интересен, когда период доходит до декабря, где он по прогнозу пересекается
    const reachesYearEnd = r.months.some((m) => m.key.endsWith('-12'));
    const notes = r.warnings.filter(
      (x) => x.level === 'warn' && x.kind !== 'no_rules' && (x.kind !== 'threshold' || reachesYearEnd),
    );
    for (const w of notes.slice(0, 2)) {
      paragraphs.push(w.text);
      evidence.push(`Примечание расчёта: ${w.text}`);
    }
    const q = i.period!.kind === 'quarter' || i.period!.kind === 'year' || i.period!.kind === 'ytd';
    const pay = paymentLines(c, ['vat'], scope);
    if (q) paragraphs.push('НДС платится тремя равными частями до 28 числа трёх месяцев после квартала.');
    if (pay) {
      paragraphs.push(pay);
      evidence.push(`График платежей: ${pay}`);
    }
  }

  const rows: string[][] = r.entities
    .filter((e) => e.applicable)
    .map((e) => [
      `${e.name}${e.rate ? ` (${e.rate}%)` : ''}`,
      e.revenue ? mln2(e.revenue) : 'нет данных',
      e.tax ? mln2(e.tax) : 'нет',
    ]);
  const tables: Table[] = [];
  if (rows.length > 0) {
    const many = rows.length > 1;
    const q = i.period!.kind === 'quarter' ? ` за ${i.period!.quarter} квартал` : '';
    if (many) rows.push([`Всего${q}`, r.revenue ? mln2(r.revenue) : '', r.total ? mln2(r.total) : '']);
    tables.push({ head: ['Юрлицо', 'Выручка', 'НДС'], rows, totalRow: many });
  }
  const byMonth = monthTable(r, 'НДС');
  if (byMonth) tables.push(byMonth);

  return {
    result: {
      intent: 'amount',
      paragraphs,
      tables,
      how: [...howLines([r], c), ...evidence],
      entityId: scope.length === 1 ? scope[0] : null,
    },
    kind,
    scope,
    calcs: [{ result: r, scope: askedScope(c, scope) }],
  };
}

// ===== Налог по УСН и налог на прибыль =====

function incomeAnswer(c: TaxAnswerContext, i: Interpretation, scope: string[], names: Map<string, string>): TaxAnswer {
  const regimes = new Map(c.data.entities.map((e) => [e.id, e.taxRegime]));
  const usnIds = scope.filter((id) => regimes.get(id) !== 'osno');
  const osnoIds = scope.filter((id) => regimes.get(id) === 'osno');
  const named = i.entityMode === 'named';

  // УСН по группе: только упрощенцы. Налог на прибыль по группе: налоги с доходов всех юрлиц,
  // как блок «Налог на прибыль и УСН» на дашборде, потому что у большинства юрлиц налога на прибыль нет.
  const showUsn = usnIds.length > 0 && (i.tax === 'profit' || i.tax === 'usn');
  const showProfit = osnoIds.length > 0 && (i.tax === 'profit' || (i.tax === 'usn' && named));

  const rate = i.rate ?? undefined;
  const rU = showUsn ? calcTax({ entityIds: usnIds, tax: 'usn', period: i.period!, rate }, c.data) : null;
  const rP = showProfit ? calcTax({ entityIds: osnoIds, tax: 'profit', period: i.period!, rate }, c.data) : null;
  const results = [rU, rP].filter((x): x is TaxCalc => x !== null);

  const kind = periodKindOf(statusesOf(...results));
  const phrase = periodPhrase(i, c.now);
  const heading = rU && rP ? 'Налог на прибыль и УСН' : rU ? 'Налог по УСН' : 'Налог на прибыль';
  const where = scopeText(i, names);
  const known = results.every((r) => r.total !== null);
  const total: Dec | null = known ? results.reduce((a, r) => a.plus(r.total!), ZERO) : null;
  const paragraphs: string[] = [];
  const evidence: string[] = [];

  if (total === null) {
    paragraphs.push(`${heading} ${phrase}${where} не рассчитан.`);
    for (const r of results) {
      for (const w of r.warnings.filter((x) => x.kind === 'no_rules' || x.kind === 'no_data')) paragraphs.push(w.text);
    }
    paragraphs.push(c.canDo);
  } else {
    const parts: string[] = [];
    if (rP && rU) {
      parts.push(`налог на прибыль ${mln2(rP.total!)}`, `налог по УСН ${mln2(rU.total!)}`);
      evidence.push(`Итоги по режимам: налог на прибыль ${mln2(rP.total!)}, налог по УСН ${mln2(rU.total!)}`);
    }
    paragraphs.push(
      `${heading} ${phrase}${where}: ${mln2(total)}.` + (parts.length ? ` Из них ${parts.join(' и ')}.` : ''),
    );
    const first = results[0]!.entities.find((e) => e.applicable);
    const monthsOf = (first?.months ?? []).map((m) => ({ month: m.month, status: m.status }));
    paragraphs.push(kindSentence(monthsOf, kind));
    if (i.tax === 'profit' && rU) {
      const list = rU.entities.filter((e) => e.applicable).map((e) => e.name);
      paragraphs.push(`У юрлиц на УСН налога на прибыль нет, для них показан налог по УСН: ${list.join(', ')}.`);
    }
    if (i.tax === 'usn' && rP) {
      const list = rP.entities.filter((e) => e.applicable).map((e) => e.name);
      paragraphs.push(`${list.join(', ')} на ОСНО, налога по УСН нет, показан налог на прибыль.`);
    }
    const kinds: ('usn' | 'profit')[] = [];
    if (rU) kinds.push('usn');
    if (rP) kinds.push('profit');
    const pay = paymentLines(c, kinds, [...(rU ? usnIds : []), ...(rP ? osnoIds : [])]);
    if (pay) {
      paragraphs.push(pay);
      evidence.push(`График платежей: ${pay}`);
    }
    paragraphs.push(
      'Суммы ориентировочные: без страховых взносов и региональных льгот, данные демо. Ставки и сроки взяты из справочника, проверьте с бухгалтером.',
    );
  }

  // таблица по юрлицам, как на дашборде: режим под названием, ближайший платёж двумя строками
  const today = { year: c.now.year, month: c.now.month, day: c.now.day };
  const byId = new Map<string, EntityInput>(c.input.entities.map((e) => [e.id, e]));
  const rows: string[][] = [];
  for (const r of results) {
    for (const e of r.entities) {
      if (!e.applicable) continue;
      const ent = byId.get(e.entityId)!;
      const ratePct = incomeTaxRate(ent, c.input.ctx).times(100);
      const next = nextPayment(incomeTaxSchedule(ent, c.input.ctx, c.input.selections, c.now), today);
      rows.push([
        `${e.name}\n${REGIME_LABEL[e.regime]}, ${ratePct.toString()}%`,
        e.tax ? mln2(e.tax) : 'нет',
        next ? `${dateRu(next.due)}${next.kind === 'final' ? ` ${next.due.year}` : ''}\n${rub(next.amount)}` : 'нет',
      ]);
    }
  }
  const tables: Table[] = [];
  if (rows.length > 0) {
    const many = rows.length > 1;
    if (many) rows.push(['Всего', total ? mln2(total) : '', '']);
    const column = i.period!.kind === 'year' && i.period!.year === c.now.year ? 'За год' : phrase.replace(/^за /, 'За ').replace(/^с /, 'С ');
    tables.push({ head: ['Юрлицо и режим', column, 'Ближайший платёж'], rows, totalRow: many });
  }
  if (results.length === 1) {
    const byMonth = monthTable(results[0]!, heading);
    if (byMonth) tables.push(byMonth);
  }

  return {
    result: {
      intent: 'amount',
      paragraphs,
      tables,
      how: [...howLines(results, c), ...evidence],
      entityId: scope.length === 1 ? scope[0] : null,
    },
    kind,
    scope,
    calcs: results.map((r) => ({ result: r, scope: askedScope(c, scope) })),
  };
}

/**
 * Строит ответ о сумме налога. Бросает ошибку расчёта (CalcInputError, PeriodError):
 * вызывающий превращает её в мягкий отказ.
 */
export function buildTaxAnswer(c: TaxAnswerContext, i: Interpretation, names: Map<string, string>): TaxAnswer {
  if (!i.tax || !i.period) throw new Error('Для расчёта нужны налог и период');
  const all = c.data.entities.map((e) => e.id);
  const scope = i.entityMode === 'named' && i.entities.length > 0 ? i.entities : all;
  return i.tax === 'vat' ? vatAnswer(c, i, scope, names) : incomeAnswer(c, i, scope, names);
}
