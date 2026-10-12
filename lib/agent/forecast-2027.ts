import {
  MONTHS_PREPOSITIONAL,
  compareRates,
  formatPeriodFor,
  mln,
  rub,
  rub2,
  scenarioLine,
  sourceLine,
  type Dec,
  type ForecastScenario,
  type Rate,
} from '@/lib/calc';
import { dativeName, shortName } from './entities';
import { isoToRu, ruleLine, type AnswerCalc, type TaxAnswerContext } from './tax-answer';
import type { CalcResult, EntityRef, Interpretation, QuickReply, Table } from './types';

/**
 * Прогноз НДС на следующий год (2027). Вопросы «какую ставку выбрать на 2027 год», «сколько
 * заплатим в 2027», «что будет с налогом в следующем году» считает расчётный сервис по сценарию
 * (lib/calc/service.ts, compareRates): выручка каждого юрлица как годовая выручка текущего года с
 * коэффициентом роста, по месяцам по сезонности, лимиты как в текущем году, пока дефлятор не
 * утверждён. Здесь только слова вокруг результата: все числа из расчётного сервиса.
 */

const RATES: readonly Rate[] = [5, 7, 22];

const mln2 = (d: Dec) => mln(d, 2);

export interface ForecastAnswer {
  result: CalcResult;
  /** Юрлица, по которым посчитано */
  scope: string[];
  calcs: AnswerCalc[];
  /** Допущения сценария одной строкой для карточки «Понял так» */
  note: string;
  quick: QuickReply[];
}

/** «в ноябре и декабре» из окна выбора ставки в справочнике. */
function windowText(months: number[]): string {
  const names = months.map((m) => MONTHS_PREPOSITIONAL[m - 1]!);
  if (names.length === 0) return '';
  if (names.length === 1) return `в ${names[0]}`;
  return `в ${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
}

export function buildForecastAnswer(
  c: TaxAnswerContext,
  i: Interpretation,
  entities: EntityRef[],
): ForecastAnswer {
  if (!i.forecast || !i.period) throw new Error('Для прогноза нужны следующий год и период');
  const scenario: ForecastScenario = { kind: 'forecast', year: i.forecast.year, growth: i.forecast.growth };
  const all = c.data.entities.map((e) => e.id);
  const scope = i.entityMode === 'named' && i.entities.length > 0 ? i.entities : all;
  const cmp = compareRates(
    { entityIds: scope.length === all.length ? 'all' : scope, period: i.period, scenario },
    c.data,
  );
  const info = cmp.scenario!;
  const year = info.year;
  const phrase = formatPeriodFor(i.period);
  const first = cmp.runs[0]!.result;
  // охват в снимках тот, о котором спросили (вся группа или названные юрлица), а не подмножество
  // прогона: юрлица на ОСНО в прогонах на 5% и 7% не участвуют, но группа остаётся группой
  const asked: string[] | 'all' = scope.length === all.length ? 'all' : scope;
  const calcs: AnswerCalc[] = cmp.runs.map((r) => ({ result: r.result, scope: asked }));

  // ===== абзацы =====
  const paragraphs: string[] = [];
  const priced = cmp.rows.filter((r) => !r.exemptAll);
  const only = scope.length === 1;
  if (only && priced.length === 1) {
    const r = priced[0]!;
    paragraphs.push(
      `Прогноз НДС ${phrase} по ${r.name}: лучшая ставка ${r.best}%, налог ${mln2(r.tax[r.best!])}. ` +
        `Экономия против ${r.against}%: ${mln2(r.saving!)}.`,
    );
  } else if (only && cmp.osno.length === 1) {
    paragraphs.push(`Прогноз НДС ${phrase} по ${cmp.osno[0]!.name}: ${mln2(cmp.osno[0]!.tax)}.`);
  } else if (only && cmp.rows.length === 1) {
    paragraphs.push(`Прогноз НДС ${phrase} по ${cmp.rows[0]!.name}: налог 0 ₽ при любой ставке.`);
  } else {
    const where = i.entityMode === 'named' ? 'по названным юрлицам' : 'по группе';
    paragraphs.push(
      `Прогноз НДС ${phrase} ${where} при лучших ставках: ${mln2(cmp.bestTotal)}` +
        (cmp.savingTotal.gt(0) ? `. Экономия против следующих по выгоде: ${mln2(cmp.savingTotal)}.` : '.'),
    );
  }

  const stay = cmp.rows.filter((r) => r.exemptAll).map((r) => r.name);
  if (stay.length > 0) {
    paragraphs.push(`Освобождены от НДС и в ${year} году не платят: ${stay.join(', ')}.`);
  }
  // были освобождены, а теперь платят весь период: порог пройден в текущем году
  const turned = cmp.rows
    .filter((r) => {
      const e = c.data.entities.find((x) => x.id === r.entityId)!;
      const months = first.entities.find((x) => x.entityId === r.entityId)?.months ?? [];
      return e.status === 'exempt' && !r.exemptAll && months.length > 0 && months.every((m) => !m.exempt);
    })
    .map((r) => r.name);
  if (turned.length > 0) {
    paragraphs.push(
      `С 1 января ${year} года платят НДС, потому что выручка ${year - 1} года выше порога освобождения: ` +
        `${turned.join(', ')}.`,
    );
  }
  if (cmp.rows.length > 0 || scope.length > 1) {
    for (const r of cmp.osno) {
      paragraphs.push(`${r.name} на ОСНО: ставка одна, 22% с вычетами, налог ${mln2(r.tax)}.`);
    }
  }
  paragraphs.push(
    `Ставку на ${year} год выбирают ${windowText(c.input.ctx.rules.rateWindowMonths)} ${year - 1} года.`,
  );

  // ===== таблицы =====
  const tables: Table[] = [];
  if (cmp.rows.length > 0) {
    const body = cmp.rows.map((r) => [r.name, ...RATES.map((rate) => mln2(r.tax[rate]))]);
    const best: [number, number][] = [];
    cmp.rows.forEach((r, k) => {
      if (r.best !== null) best.push([k, 1 + RATES.indexOf(r.best)]);
    });
    const many = cmp.rows.length > 1;
    if (many) body.push(['Всего', ...RATES.map((rate) => mln2(cmp.totals[rate]))]);
    tables.push({ head: ['Юрлицо', ...RATES.map((r) => `${r}%`)], rows: body, best, totalRow: many });
  }
  if (cmp.rows.length > 1) {
    tables.push({
      head: ['Юрлицо', 'Лучшая', 'Экономия'],
      rows: cmp.rows.map((r) =>
        r.best === null ? [r.name, 'не платит', ''] : [r.name, `${r.best}%`, `${mln2(r.saving!)} против ${r.against}%`],
      ),
    });
  }

  // ===== как посчитано =====
  const how: string[] = [...first.assumptions];
  const all22 = cmp.runs.find((r) => r.rate === 22)!.result;
  for (const e of all22.entities) {
    if (e.applicable && e.revenue !== null) how.push(`${e.name}: выручка ${year} года с НДС ${rub(e.revenue)}`);
  }
  for (const run of cmp.runs) {
    for (const e of run.result.entities) {
      if (!e.applicable) continue;
      const step = run.result.steps.find((s) => s.id === e.taxStep);
      if (step) how.push(`${e.name}, ставка ${run.rate}%: ${step.text}`);
    }
  }
  if (cmp.rows.length > 0 || cmp.osno.length > 0) {
    how.push(`Итого при лучших ставках: ${rub2(cmp.bestTotal)}`);
    if (cmp.savingTotal.gt(0)) how.push(`Экономия против следующих по выгоде: ${rub2(cmp.savingTotal)}`);
  }
  const rules = new Map<string, string>();
  for (const run of cmp.runs) for (const x of run.result.rules) rules.set(`${x.key}|${x.validFrom}`, ruleLine(x));
  for (const line of rules.values()) how.push(`Правило: ${line}`);
  if (first.source) how.push(`Источник: ${sourceLine(first.source, c.tz)}`);
  how.push(`Расчёт на ${isoToRu(first.asOf)}`);

  // ===== кнопки быстрых ответов =====
  const g = scenario.growth;
  const quick: QuickReply[] = [];
  if (g !== 10) quick.push({ label: 'Рост +10%', text: 'рост выручки +10%' });
  if (g !== 20) quick.push({ label: 'Рост +20%', text: 'рост выручки +20%' });
  if (g !== 0) quick.push({ label: 'Без роста', text: 'без роста' });
  if (!only) {
    const ids = new Set(cmp.rows.map((r) => r.entityId));
    const e = entities.find((x) => ids.has(x.id));
    if (e) quick.push({ label: `Только ${shortName(e)}`, text: `по ${dativeName(shortName(e))}` });
  }

  return {
    result: { intent: 'amount', paragraphs, tables, how, entityId: only ? scope[0] : null },
    scope,
    calcs,
    note: scenarioLine(info),
    quick,
  };
}
