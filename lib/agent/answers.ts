import {
  bestRate,
  breakEvenShare,
  buildWarnings,
  compareDays,
  dateRu,
  dec,
  forecast,
  groupPayments,
  groupSaving,
  groupTotal,
  incomeTax,
  mln,
  nextPayment,
  incomeTaxSchedule,
  pct,
  quarterRevenue,
  pluralRu,
  rub,
  selectedRate,
  REGIME_LABEL,
  sum,
  taxFor,
  type DashboardInput,
  type Dec,
  type EntityInput,
  type Moment,
  type Rate,
} from '@/lib/calc';
import type { CalcResult, Intent, ParsedIntent, Table } from './types';

/**
 * Ответы по теме. Все числа берутся из lib/calc, текст только подставляет их в слова.
 * Расчёты из прототипа (reference/demo.html) сюда не копировались.
 */
export interface AnswerCtx {
  input: DashboardInput;
  now: Moment;
}

const comma = (d: Dec) => d.toString().replace('.', ',');

function pick(c: AnswerCtx, entityId?: string | null): EntityInput[] {
  const all = c.input.entities;
  if (!entityId) return all;
  const one = all.filter((e) => e.id === entityId);
  return one.length ? one : all;
}

function minRate(values: Record<number, Dec>, rates: Rate[]): Rate {
  let best = rates[0]!;
  for (const r of rates.slice(1)) if (values[r]!.lt(values[best]!)) best = r;
  return best;
}

export function answerRates(c: AnswerCtx, entityId?: string | null): CalcResult {
  const { selections, ctx } = c.input;
  const rates = ctx.rules.rates;
  const g = ctx.rules.generalRate;
  const all = pick(c, entityId);
  // На ОСНО ставка НДС одна, сравнивать нечего: такие юрлица описаны отдельной фразой
  const osno = all.filter((e) => e.taxRegime === 'osno');
  const list = all.filter((e) => e.taxRegime !== 'osno');
  const rows: string[][] = [];
  const best: [number, number][] = [];
  const how: string[] = [];
  const totals: Record<number, Dec[]> = Object.fromEntries(rates.map((r) => [r, [] as Dec[]]));
  const hasExempt = list.some((e) => e.status === 'exempt');

  list.forEach((e, i) => {
    const vals: Record<number, Dec> = {};
    for (const r of rates) {
      vals[r] =
        e.status === 'payer' ? forecast(e, ctx, r, c.now) : taxFor(r, e.annualRevenue, e.inputVatShare, g);
      totals[r]!.push(vals[r]!);
    }
    const mb = minRate(vals, rates);
    rows.push([`${e.name}${e.status === 'exempt' ? '*' : ''}`, ...rates.map((r) => mln(vals[r]!, 2))]);
    best.push([i, 1 + rates.indexOf(mb)]);
    how.push(
      `${e.name}: 5% = ${rub(e.annualRevenue)} × 5/105; ${g}% = ${rub(e.annualRevenue)} × ${g}/${100 + g} × (1 − ${comma(e.inputVatShare)})`,
    );
  });

  let totalRow = false;
  if (list.length > 1) {
    rows.push(['Всего', ...rates.map((r) => mln(groupTotal(totals[r]!), 2))]);
    totalRow = true;
  }

  const osnoLines = osno.map((e) => {
    const v = forecast(e, ctx, g, c.now);
    how.push(`${e.name}: ${g}% = ${rub(e.annualRevenue)} × ${g}/${100 + g} × (1 − ${comma(e.inputVatShare)})`);
    return `${e.name} на ОСНО: ставка НДС одна, ${g}% с вычетами, выбора нет. Прогноз НДС за год ${mln(v, 2)}.`;
  });

  if (list.length === 0) {
    return { intent: 'rates', entityId, paragraphs: osnoLines, tables: [], how };
  }

  const paragraphs = ['Налог за год по трём ставкам. Лучшая для каждого юрлица выделена.'];
  const save = groupSaving(list, selections, ctx, c.now);
  if (save.gt(0)) {
    paragraphs.push(`Сейчас выбрано так, что переплата составляет около ${mln(save, 2)} в год.`);
    for (const e of list) {
      const sel = selectedRate(e, selections);
      const b = bestRate(e, ctx, c.now);
      const diff = forecast(e, ctx, sel, c.now).minus(forecast(e, ctx, b, c.now));
      if (e.status === 'payer' && diff.gt(0)) {
        paragraphs.push(
          `${e.name}: ставка ${b}% дешевле выбранной ${sel}% на ${rub(diff)} в год, закупки с НДС ${pct(e.inputVatShare)} от выручки.`,
        );
      }
    }
  } else {
    paragraphs.push('Выбранные ставки уже самые дешёвые.');
  }
  paragraphs.push(
    'Что учесть: при 5% и 7% покупатели-юрлица не получают вычет и могут уйти.' +
      (hasExempt ? ' Звёздочка: юрлицо освобождено, цифры показывают налог, если порог будет пройден.' : ''),
  );
  paragraphs.push(...osnoLines);

  return {
    intent: 'rates',
    entityId,
    paragraphs,
    tables: [{ head: ['Юрлицо', ...rates.map((r) => `${r}%`)], rows, best, totalRow }],
    how,
  };
}

export function answerWarnings(c: AnswerCtx, entityId?: string | null): CalcResult {
  const { entities, selections, ctx } = c.input;
  let list = buildWarnings(entities, selections, ctx, c.now).filter((w) => w.level !== 'info');
  if (entityId) list = list.filter((w) => !w.entityId || w.entityId === entityId);
  const paragraphs = list.length
    ? [
        `Сейчас вижу ${list.length} ${pluralRu(list.length, 'предупреждение', 'предупреждения', 'предупреждений')}:`,
        ...list.map((w) => `${w.title}. ${w.text}`),
      ]
    : ['Предупреждений по порогам сейчас нет.'];
  return {
    intent: 'warnings',
    entityId,
    paragraphs,
    tables: [],
    how: [
      `Порог ${mln(ctx.rules.vatExemptLimit, 0)}: прогноз пересечения по сезонным весам месяцев и годовому прогнозу юрлица`,
    ],
  };
}

export function answerFragmentation(c: AnswerCtx): CalcResult {
  const { entities, selections, ctx } = c.input;
  // лимит ставки 5% относится к выручке на УСН: юрлица на ОСНО в сумму не входят
  const usn = entities.filter((e) => e.taxRegime !== 'osno');
  const total = groupTotal(usn.map((e) => e.annualRevenue));
  const signs = ctx.rules.groupSigns ?? 'общий бренд, один сайт, общий парк';
  const paragraphs = [
    `Видимые признаки: ${signs}. Это то, что смотрят при проверке дробления.`,
  ];
  if (ctx.rules.limit5) {
    paragraphs.push(
      `Суммарная выручка группы ${mln(total, 1)} за год, ${pct(total.div(ctx.rules.limit5))} от лимита ставки 5%. ` +
        `Такие схемы я не проектирую, но могу показать, насколько близка группа к границе и во сколько обойдётся риск.`,
    );
  }
  const exempt = entities.filter((e) => e.status === 'exempt');
  if (exempt.length) {
    const tax = groupTotal(
      exempt.map((e) =>
        taxFor(selectedRate(e, selections), e.annualRevenue, e.inputVatShare, ctx.rules.generalRate),
      ),
    );
    paragraphs.push(
      `Если выручку объединят, освобождённые юрлица потеряют освобождение: оценка НДС по их выручке ${rub(tax)} в год по выбранным ставкам.`,
    );
  }
  return {
    intent: 'fragmentation',
    paragraphs,
    tables: [],
    how: [`Сумма прогнозов выручки ${usn.length} юрлиц на УСН: ${rub(total)}`],
  };
}

export function answerForecast(c: AnswerCtx, entityId?: string | null): CalcResult {
  const { selections, ctx } = c.input;
  const g = ctx.rules.generalRate;
  const payers = pick(c, entityId).filter((e) => e.status === 'payer');
  const q = Math.floor(c.now.month / 3);
  const qRev = (e: EntityInput, quarter: number): Dec => quarterRevenue(e, ctx, quarter, c.now);

  const rows: string[][] = [];
  const how: string[] = [];
  const taxes: Dec[] = [];
  for (const e of payers) {
    const rate = selectedRate(e, selections);
    const rev = qRev(e, q);
    const t = taxFor(rate, rev, e.inputVatShare, g);
    taxes.push(t);
    rows.push([`${e.name} (${rate}%)`, mln(t, 2)]);
    how.push(`${e.name}: ${rub(rev)} выручки квартала, ставка ${rate}%`);
  }
  const total = groupTotal(taxes);
  rows.push([`Всего за ${q + 1} квартал`, mln(total, 2)]);

  const paragraphs = [`Налог за текущий ${q + 1} квартал по выбранным ставкам, только плательщики:`];

  const prev = q - 1;
  if (prev >= 0) {
    const prevTotal = groupTotal(
      payers.map((e) => taxFor(selectedRate(e, selections), qRev(e, prev), e.inputVatShare, g)),
    );
    const today = { year: c.now.year, month: c.now.month, day: c.now.day };
    let next: { month: number; day: number } | null = null;
    for (let k = 0; k < 3; k++) {
      const d = { year: c.now.year, month: (prev + 1) * 3 + k, day: 28 };
      if (compareDays(d, today) >= 0) {
        next = d;
        break;
      }
    }
    paragraphs.push(
      `За ${prev + 1} квартал начислено ${mln(prevTotal, 2)}. НДС платится тремя равными частями до 28 числа трёх месяцев после квартала` +
        (next ? `, ближайший платёж ${dateRu(next)} примерно ${rub(prevTotal.div(3))}.` : '.'),
    );
    how.push(`${prev + 1} квартал: ${rub(prevTotal)} ÷ 3 по 28 числам`);
  }

  return {
    intent: 'forecast',
    entityId,
    paragraphs,
    tables: [{ head: ['Юрлицо', 'Налог'], rows, totalRow: true }],
    how,
  };
}

export function answerDeduct(c: AnswerCtx): CalcResult {
  const { entities, ctx } = c.input;
  const g = ctx.rules.generalRate;
  const low = ctx.rules.rates[0]!;
  const limit = breakEvenShare(low, g);
  const shares = entities
    .filter((e) => e.status === 'payer')
    .map((e) => `${e.name} ${pct(e.inputVatShare)}`)
    .join(', ');
  return {
    intent: 'deduct',
    paragraphs: [
      'Вычет это входной НДС из счетов-фактур поставщиков: покупка машин, лизинг, ремонт, топливо. ' +
        `Он работает только при ${g}%. При 5% и 7% входной НДС в расчёт не идёт.`,
      `Поэтому у капиталоёмкого проката выбор ставки зависит от доли закупок с НДС. Граница около ${pct(limit, 1)} выручки: ` +
        `выше выгодна ${g}%, ниже ${low}%. Доля закупок с НДС у плательщиков: ${shares}.`,
    ],
    tables: [],
    how: [`Граница: ${g}/${100 + g} × (1 − доля) = ${low}/${100 + low}, отсюда доля = ${pct(limit, 1)}`],
  };
}

/**
 * Налог на прибыль (ОСНО) и налог по УСН по группе: режим, начислено, прогноз за год, ближайший срок.
 * Все числа из lib/calc/income-tax. Суммы ориентировочные, без страховых взносов.
 */
export function answerIncomeTax(c: AnswerCtx, entityId?: string | null): CalcResult {
  const { selections, ctx } = c.input;
  const list = pick(c, entityId);
  const today = { year: c.now.year, month: c.now.month, day: c.now.day };

  const rows: string[][] = [];
  const how: string[] = [];
  const accrued: Dec[] = [];
  const yearly: Dec[] = [];
  let profit: Dec[] = [];
  let usn: Dec[] = [];

  for (const e of list) {
    const t = incomeTax(e, ctx, selections, c.now);
    const next = nextPayment(incomeTaxSchedule(e, ctx, selections, c.now), today);
    accrued.push(t.accrued);
    yearly.push(t.forecast);
    if (e.taxRegime === 'osno') profit = [...profit, t.forecast];
    else usn = [...usn, t.forecast];
    // Режим второй строкой в первой ячейке, срок и сумма двумя строками: таблица помещается на телефоне
    rows.push([
      `${e.name}\n${REGIME_LABEL[e.taxRegime]}, ${t.ratePct.toString()}%`,
      mln(t.forecast, 2),
      next ? `${dateRu(next.due)}${next.kind === 'final' ? ` ${next.due.year}` : ''}\n${rub(next.amount)}` : 'нет',
    ]);

    how.push(`${e.name}: начислено на сегодня ${rub(t.accrued)} (доля накопленной выручки × налог за год)`);
    const r = selectedRate(e, selections);
    const vatNote = e.status === 'payer' ? ` × 100 / ${100 + r}` : '';
    const incomeLine =
      e.status === 'payer'
        ? `выручка без НДС = ${rub(e.annualRevenue)}${vatNote} = ${rub(t.income)}`
        : `выручка = ${rub(e.annualRevenue)} (НДС не платится)`;
    switch (e.taxRegime) {
      case 'osno':
        how.push(
          `${e.name}: ${incomeLine}; прибыль = ${rub(t.income)} − расходы ${rub(t.expenses)} = ${rub(t.base)}; ` +
            `налог = ${rub(t.base)} × ${t.ratePct.toString()}% = ${rub(t.forecast)}`,
        );
        break;
      case 'usn_income':
        how.push(
          `${e.name}: ${incomeLine}; налог = ${rub(t.income)} × ${t.ratePct.toString()}% = ${rub(t.forecast)}`,
        );
        break;
      case 'usn_income_expense':
        how.push(
          `${e.name}: ${incomeLine}; (доходы ${rub(t.income)} − расходы ${rub(t.expenses)}) × ${t.ratePct.toString()}% = ${rub(t.calculated)}; ` +
            `минимальный налог 1% доходов = ${rub(t.minimum)}; к уплате ${rub(t.forecast)}`,
        );
        break;
    }
  }

  if (list.length > 1) {
    rows.push(['Всего', mln(groupTotal(yearly), 2), '']);
    how.push(`Начислено на сегодня по группе: ${rub(groupTotal(accrued))}`);
  }

  const profitTotal = groupTotal(profit);
  const usnTotal = groupTotal(usn);
  const paragraphs = [
    `Налог на прибыль и УСН за год: ${mln(groupTotal(yearly), 2)}.` +
      (profit.length ? ` Налог на прибыль по ОСНО ${mln(profitTotal, 2)}.` : '') +
      (usn.length ? ` Налог по УСН ${mln(usnTotal, 2)}.` : ''),
  ];

  // ближайшая дата платежей по доходным налогам
  const upcoming = groupPayments(list, selections, ctx, c.now).filter((p) => p.kind !== 'vat');
  const first = upcoming[0];
  if (first) {
    const same = upcoming.filter((p) => p.due.year === first.due.year && p.due.month === first.due.month && p.due.day === first.due.day);
    const sumUsn = groupTotal(same.filter((p) => p.kind === 'usn').map((p) => p.amount));
    const sumProfit = groupTotal(same.filter((p) => p.kind === 'profit').map((p) => p.amount));
    const parts = [
      sumUsn.gt(0) ? `по УСН ${rub(sumUsn)}` : null,
      sumProfit.gt(0) ? `по налогу на прибыль ${rub(sumProfit)}` : null,
    ].filter((x): x is string => x !== null);
    paragraphs.push(
      `Ближайший срок ${dateRu(first.due)}: ${same[0]!.final ? 'итоговая уплата' : 'авансовые платежи'} ${same[0]!.periodLabel}, ${parts.join(' и ')}.`,
    );
  }
  paragraphs.push(
    'Суммы ориентировочные: без страховых взносов и региональных льгот, данные демо. Ставки и сроки взяты из справочника, проверьте с бухгалтером.',
  );

  return {
    intent: 'profit',
    entityId,
    paragraphs,
    tables: [
      {
        head: ['Юрлицо и режим', 'За год', 'Ближайший платёж'],
        rows,
        totalRow: list.length > 1,
      },
    ],
    how,
  };
}

export function answerScenario(
  c: AnswerCtx,
  p: { entityId: string; cars: number; priceMln: number },
): CalcResult {
  const { ctx } = c.input;
  const g = ctx.rules.generalRate;
  const e = c.input.entities.find((x) => x.id === p.entityId)!;
  const n = Math.min(Math.max(Math.round(p.cars), 1), 20);
  const price = dec(p.priceMln);
  const buy = price.times(n).times(1_000_000);
  const vat = buy.times(g).div(100 + g);
  const p2 = e.inputVatShare.plus(buy.div(e.annualRevenue));
  const t5 = taxFor(5, e.annualRevenue, e.inputVatShare, g);
  const before = taxFor(g, e.annualRevenue, e.inputVatShare, g);
  const after = taxFor(g, e.annualRevenue, p2, g);
  const priceText = comma(price);

  const osno = e.taxRegime === 'osno';
  const paragraphs = [
    `Сценарий: ${e.name} покупает ${n} ${pluralRu(n, 'машину', 'машины', 'машин')} по ${priceText} млн ₽ с НДС, всего ${mln(buy, 1)}.`,
    `Входной НДС в покупке ${rub(vat)}. Доля закупок с НДС вырастет с ${pct(e.inputVatShare)} до ${pct(p2)}.`,
    osno
      ? `${after.isNegative() ? 'Отрицательное число означает НДС к возмещению из бюджета. ' : ''}` +
        `Ставка одна, ${g}% с вычетами: вычет снижает НДС за год на ${rub(before.minus(after))}, с ${mln(before, 2)} до ${mln(after, 2)}.`
      : `${after.isNegative() ? 'Отрицательное число означает НДС к возмещению из бюджета. ' : ''}` +
        `При 5% покупка на налог не влияет, при ${g}% вычет снижает его на ${rub(before.minus(after))}. ` +
        (after.lt(t5)
          ? `После покупки ставка ${g}% выгоднее 5% на ${rub(t5.minus(after))} в год.`
          : 'Даже после покупки 5% остаётся дешевле.'),
    'Вычет возможен после принятия машины на учёт и при наличии счёта-фактуры. Сумма условная: данные выдуманы.',
  ];
  if (e.status === 'exempt') {
    paragraphs.splice(
      3,
      0,
      `${e.name} сейчас освобождено от НДС: вычет появится после перехода порога, цифры показывают налог при переходе.`,
    );
  }

  return {
    intent: 'scenario',
    entityId: e.id,
    paragraphs,
    tables: [
      {
        head: ['Ставка за год', 'До', 'После'],
        rows: osno
          ? [[`${g}%`, mln(before, 2), mln(after, 2)]]
          : [
              ['5%', mln(t5, 2), mln(t5, 2)],
              [`${g}%`, mln(before, 2), mln(after, 2)],
            ],
        best: osno ? [[0, 2]] : [[1, 2]],
      },
    ],
    how: [
      `Закупки: ${n} × ${priceText} млн = ${rub(buy)}`,
      `Входной НДС = ${rub(buy)} × ${g}/${100 + g} = ${rub(vat)}`,
      `Доля: ${comma(e.inputVatShare)} + ${rub(buy)} / ${rub(e.annualRevenue)} = ${comma(p2.toDecimalPlaces(3))}`,
    ],
  };
}

/** Полный текст результата: то, из чего предохранитель берёт допустимые числа. */
export function resultSources(r: CalcResult): string[] {
  const tableText = (t: Table) => [...t.head, ...t.rows.flat()].join(' ');
  return [...r.paragraphs, ...r.tables.map(tableText), ...r.how];
}

export function buildAnswer(
  parsed: ParsedIntent & { intent: Intent },
  c: AnswerCtx,
): CalcResult {
  switch (parsed.intent) {
    case 'rates':
      return answerRates(c, parsed.entityId);
    case 'warnings':
      return answerWarnings(c, parsed.entityId);
    case 'fragmentation':
      return answerFragmentation(c);
    case 'forecast':
      return answerForecast(c, parsed.entityId);
    case 'deduct':
      return answerDeduct(c);
    case 'profit':
      return answerIncomeTax(c, parsed.entityId);
    case 'scenario':
      return answerScenario(c, {
        entityId: parsed.entityId!,
        cars: parsed.cars!,
        priceMln: parsed.priceMln!,
      });
    default:
      throw new Error(`Нет построителя для намерения ${parsed.intent}`);
  }
}
