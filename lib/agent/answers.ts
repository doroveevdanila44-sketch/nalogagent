import {
  bestRate,
  breakEvenShare,
  buildWarnings,
  dec,
  forecast,
  groupSaving,
  groupTotal,
  mln,
  pct,
  pluralRu,
  rub,
  selectedRate,
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
  /** Несколько юрлиц, названных в вопросе: ответ только по ним */
  only?: string[];
}

const comma = (d: Dec) => d.toString().replace('.', ',');

function pick(c: AnswerCtx, entityId?: string | null): EntityInput[] {
  const all = c.only?.length ? c.input.entities.filter((e) => c.only!.includes(e.id)) : c.input.entities;
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
  else if (c.only?.length) list = list.filter((w) => !w.entityId || c.only!.includes(w.entityId));
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
    case 'deduct':
      return answerDeduct(c);
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
