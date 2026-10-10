import { bestRate, crossing, forecast, selectedRate, taxFor, groupTotal } from './calc';
import { dec, sum } from './decimal';
import { dateRu, mln, pct, pluralRu, rub } from './format';
import { incomeTax, incomeTaxSchedule, nextPayment } from './income-tax';
import { daysUntil, groupPayments, sumKind } from './payments';
import type { Moment } from './time';
import { compareDays } from './time';
import type { CalcCtx, EntityInput, Selections, Warning, WarningLevel } from './types';

const TAG: Record<WarningLevel, Warning['tag']> = {
  crit: 'Срочно',
  warn: 'Внимание',
  info: 'К сведению',
};

const ORDER: Record<WarningLevel, number> = { crit: 0, warn: 1, info: 2 };

/** Запас до порога, меньше которого предупреждаем об освобождённом юрлице */
const NEAR_LIMIT_MARGIN = dec(5_000_000);

/** За сколько дней до срока платежа показывать напоминание */
const PAYMENT_LEAD_DAYS = 45;

const VAT_THIRD = ['первая треть', 'вторая треть', 'третья треть'] as const;

/**
 * Предупреждения строятся из расчёта, не из текста модели. Сортировка: crit, warn, info,
 * внутри уровня порядок формирования.
 */
export function buildWarnings(
  entities: EntityInput[],
  selections: Selections,
  ctx: CalcCtx,
  now: Moment,
): Warning[] {
  const list: Warning[] = [];
  const rules = ctx.rules;
  const limitLabel = mln(rules.vatExemptLimit, 0);
  const today = { year: now.year, month: now.month, day: now.day };

  for (const e of entities) {
    if (e.status === 'exempt') {
      const c = crossing(e, ctx, now);
      if (c) {
        const already = compareDays(c, today) <= 0;
        const startMonth = c.month + 1;
        const startsNextYear = startMonth > 11;
        const start = startsNextYear
          ? `1 января ${c.year + 1}`
          : dateRu({ month: startMonth, day: 1 });
        const t5 = taxFor(5, e.annualRevenue, e.inputVatShare, rules.generalRate);
        const t22 = taxFor(rules.generalRate, e.annualRevenue, e.inputVatShare, rules.generalRate);
        list.push({
          level: 'crit',
          kind: 'threshold-crossing',
          entityId: e.id,
          tag: TAG.crit,
          title: already
            ? `${e.name} уже пересёк порог ${limitLabel}`
            : `${e.name} пересечёт порог ${limitLabel} около ${dateRu(c)}`,
          text:
            `НДС начнёт начисляться с ${start}. Нужны счета-фактуры и выбранная ставка. ` +
            `При выручке этого года налог составил бы ${rub(t5)} при 5% и ${rub(t22)} при ${rules.generalRate}%. ` +
            `Решить заранее дешевле, чем узнать в марте.`,
        });
      } else {
        const left = rules.vatExemptLimit.minus(e.annualRevenue);
        if (left.lt(NEAR_LIMIT_MARGIN)) {
          list.push({
            level: 'warn',
            kind: 'near-threshold',
            entityId: e.id,
            tag: TAG.warn,
            title: `${e.name}: запас до порога ${mln(left, 1)}`,
            text: `Прогноз года ${mln(e.annualRevenue, 1)} из ${limitLabel}.`,
          });
        }
      }
    } else {
      const best = bestRate(e, ctx, now);
      const cur = selectedRate(e, selections);
      if (best !== cur) {
        const diff = forecast(e, ctx, cur, now).minus(forecast(e, ctx, best, now));
        const share = pct(e.inputVatShare);
        const buyers =
          'При 5% и 7% покупатели-юрлица не получают вычет и могут уйти к конкуренту.';
        const text =
          best === rules.generalRate
            ? `Сейчас выбрана ${cur}%. Закупки с НДС у юрлица ${share} от выручки, при ${best}% вычеты остаются в бизнесе. ${buyers}`
            : `Сейчас выбрана ${cur}%. Закупок с НДС у юрлица ${share} от выручки, вычеты при ${cur}% не окупают ставку. ${buyers}`;
        list.push({
          level: 'warn',
          kind: 'better-rate',
          entityId: e.id,
          tag: TAG.warn,
          title: `${e.name}: ставка ${best}% выгоднее на ${rub(diff)} в год`,
          text,
        });
      }
    }
  }

  // Лимит ставки 5% относится к выручке на УСН: юрлица на ОСНО в сумму не входят
  const usnEntities = entities.filter((e) => e.taxRegime !== 'osno');
  if (rules.groupSigns && usnEntities.length > 1 && rules.limit5) {
    const total = groupTotal(usnEntities.map((e) => e.annualRevenue));
    const share = total.div(rules.limit5);
    const exemptTax = sum(
      usnEntities
        .filter((e) => e.status === 'exempt')
        .map((e) => taxFor(selectedRate(e, selections), e.annualRevenue, e.inputVatShare, rules.generalRate)),
    );
    const owners = [...new Set(usnEntities.map((e) => e.ownerLabel))];
    list.push({
      level: 'warn',
      kind: 'unified-business',
      tag: TAG.warn,
      title: `Признаки единого бизнеса: ${rules.groupSigns}`,
      text:
        `Юрлица взаимозависимы (${owners.join(' и ')}). Если выручку объединят, группа в сумме ${mln(total, 1)} за год, ` +
        `это ${pct(share)} от лимита ставки 5% (${mln(rules.limit5, 1)}). ` +
        `Освобождённые юрлица потеряли бы освобождение: оценка НДС по их выручке ${rub(exemptTax)} в год по выбранным ставкам.`,
    });
  }

  // Ближайшая дата платежей: авансы по УСН и налогу на прибыль, доли НДС
  const upcoming = groupPayments(entities, selections, ctx, now);
  const first = upcoming[0];
  if (first && daysUntil(first.due, now) <= PAYMENT_LEAD_DAYS) {
    const same = upcoming.filter((p) => compareDays(p.due, first.due) === 0);
    const income = same.filter((p) => p.kind !== 'vat');
    const vat = same.filter((p) => p.kind === 'vat');
    const taxes = [
      income.some((p) => p.kind === 'usn') ? 'УСН' : null,
      income.some((p) => p.kind === 'profit') ? 'налогу на прибыль' : null,
    ].filter((x): x is string => x !== null);

    const parts: string[] = [];
    if (taxes.length) {
      const final = income.some((p) => p.final);
      parts.push(`${final ? 'итоговая уплата' : 'авансовые платежи'} по ${taxes.join(' и ')} ${income[0]!.periodLabel}`);
    }
    if (vat.length) parts.push(`${VAT_THIRD[(vat[0]!.vatThird ?? 1) - 1]} НДС за ${vat[0]!.vatQuarter} квартал`);

    const usnSum = sumKind(same, 'usn', first.due);
    const profitSum = sumKind(same, 'profit', first.due);
    const vatSum = sumKind(same, 'vat', first.due);
    const items = [
      usnSum.gt(0) ? `УСН ${rub(usnSum)}` : null,
      profitSum.gt(0) ? `налог на прибыль ${rub(profitSum)}` : null,
      vatSum.gt(0) ? `НДС ${rub(vatSum)}` : null,
    ].filter((x): x is string => x !== null);

    list.push({
      level: 'info',
      kind: 'payment-date',
      tag: TAG.info,
      title: `${dateRu(first.due)}: ${parts.join(' и ')}`,
      text:
        `К уплате по расчёту: ${items.join(', ')}. Всего ${rub(usnSum.plus(profitSum).plus(vatSum))}. ` +
        `Суммы ориентировочные (без страховых взносов), проверьте с бухгалтером.`,
    });
  }

  // Юрлица на ОСНО: прогноз налога на прибыль за год
  for (const e of entities.filter((x) => x.taxRegime === 'osno')) {
    const tax = incomeTax(e, ctx, selections, now);
    const next = nextPayment(incomeTaxSchedule(e, ctx, selections, now), today);
    list.push({
      level: 'info',
      kind: 'osno-profit',
      entityId: e.id,
      tag: TAG.info,
      title: `${e.name} на ОСНО: прогноз налога на прибыль за год ${mln(tax.forecast, 2)}`,
      text:
        `Прибыль за год ${mln(tax.base, 2)}: выручка без НДС ${mln(tax.income, 2)} минус расходы ${mln(tax.expenses, 2)}, ` +
        `ставка ${tax.ratePct.toString()}%. Начислено на сегодня ${rub(tax.accrued)}.` +
        (next ? ` Ближайший платёж ${dateRu(next.due)}, ${rub(next.amount)}.` : '') +
        ` Данные демо, проверьте с бухгалтером.`,
    });
  }

  const inWindowLead = now.month + 1 >= Math.min(...rules.rateWindowMonths) - 1 && now.month + 1 <= Math.max(...rules.rateWindowMonths);
  if (inWindowLead) {
    const names = rules.rateWindowMonths.map((m) => MONTH_NOM_LOWER[m - 1]).join(' и ');
    list.push({
      level: 'info',
      kind: 'rate-window',
      tag: TAG.info,
      title: `Окно выбора ставки на ${rules.nextYear.year} год: ${names}`,
      text:
        `Главное решение года. Правило ${rules.twelveQuarters} ${pluralRu(rules.twelveQuarters, 'квартала', 'кварталов', 'кварталов')} ` +
        `ограничивает возврат, поэтому до смены ставки сверьте условия с бухгалтером.`,
    });
  }

  if (!rules.nextYear.deflatorKnown) {
    const b5 = rules.nextYear.base5;
    const b7 = rules.nextYear.base7;
    const bases = b5 && b7 ? ` (${mln(b5, 0).replace(/ млн$/, '')} и ${mln(b7, 0)}, умноженные на дефлятор)` : '';
    list.push({
      level: 'info',
      kind: 'deflator-unknown',
      tag: TAG.info,
      title: `Дефлятор на ${rules.nextYear.year} год не утверждён`,
      text:
        `Лимиты ставок 5% и 7%${bases} на ${rules.nextYear.year} год пока неизвестны. ` +
        `В справочнике лежит формула, число подставим после публикации.`,
    });
  }

  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => ORDER[a.w.level] - ORDER[b.w.level] || a.i - b.i)
    .map((x) => x.w);
}

const MONTH_NOM_LOWER = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export function warningCounter(list: Warning[]): string {
  const crit = list.filter((w) => w.level === 'crit').length;
  return crit > 0 ? `Срочных: ${crit}, всего: ${list.length}` : `Всего: ${list.length}`;
}

