import { MONTH_NAMES, formatPeriod, type Moment, type Period } from '@/lib/calc';
import { dativeName, shortName } from './entities';
import type { ChangeOptions, EntityRef, Interpretation, QuickReply, Slot, TaxKind } from './types';

/**
 * Уточнения. Один короткий вопрос на то, чего не хватает, с кнопками быстрых ответов.
 * Ответ на уточнение склеивается с прежним вопросом (interpret.ts), повторять его не нужно.
 */

export const TAX_LABEL: Record<TaxKind, string> = {
  vat: 'НДС',
  usn: 'УСН',
  profit: 'Налог на прибыль',
};

/** Налог в середине фразы: «посчитать налог по УСН». */
export const TAX_PHRASE: Record<TaxKind, string> = {
  vat: 'НДС',
  usn: 'налог по УСН',
  profit: 'налог на прибыль',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function taxChoices(only?: TaxKind[]): QuickReply[] {
  const text: Record<TaxKind, string> = { vat: 'НДС', usn: 'УСН', profit: 'налог на прибыль' };
  return (only ?? (['vat', 'usn', 'profit'] as TaxKind[])).map((k) => ({
    label: TAX_LABEL[k],
    text: text[k],
    group: 'tax',
  }));
}

/**
 * Периоды для кнопок: с начала года, текущий месяц, последний завершённый квартал и год.
 * Подписи считаются от «сегодня», а не заданы константами.
 */
export function periodChoices(today: Moment): QuickReply[] {
  const month = today.month + 1;
  const q = Math.floor((month - 1) / 3) + 1;
  const prevQ = q === 1 ? { q: 4, year: today.year - 1 } : { q: q - 1, year: today.year };
  const quarterText = prevQ.year === today.year ? `${prevQ.q} квартал` : `${prevQ.q} квартал ${prevQ.year}`;
  return [
    { label: 'С начала года', text: 'с начала года', group: 'period' },
    { label: cap(MONTH_NAMES[month - 1]!), text: MONTH_NAMES[month - 1]!, group: 'period' },
    { label: quarterText, text: quarterText, group: 'period' },
    { label: `${today.year} год`, text: `${today.year} год`, group: 'period' },
  ];
}

export function entityChoices(entities: EntityRef[]): QuickReply[] {
  return [
    { label: 'Вся группа', text: 'по группе', group: 'entity' },
    ...entities.map((e) => ({
      label: shortName(e),
      text: `по ${dativeName(shortName(e))}`,
      group: 'entity' as const,
    })),
  ];
}

/** Что показать по кнопке «Изменить» у карточки. */
export function changeOptions(entities: EntityRef[], today: Moment): ChangeOptions {
  return { entity: entityChoices(entities), tax: taxChoices(), period: periodChoices(today) };
}

/** Кнопки «сузить до юрлица»: когда посчитано по группе. */
export function narrowChoices(entities: EntityRef[]): QuickReply[] {
  return entityChoices(entities).filter((r) => r.text !== 'по группе');
}

export interface Clarification {
  text: string;
  quick: QuickReply[];
  awaiting: Slot[];
}

function entitySuffix(i: Interpretation, entities: EntityRef[]): string {
  if (i.entityMode !== 'named') return '';
  const names = i.entities.map((id) => entities.find((e) => e.id === id)?.name).filter((n): n is string => Boolean(n));
  return names.length ? ` по ${names.join(' и ')}` : '';
}

function periodQuick(periods: Period[]): QuickReply[] {
  return periods.map((p) => {
    const label = formatPeriod(p);
    return { label: cap(label), text: label, group: 'period' as const };
  });
}

/**
 * Один вопрос на недостающее или неоднозначное; null, если спрашивать нечего.
 * Если не хватает и налога, и периода, это один вопрос с двумя рядами кнопок.
 */
export function clarificationFor(i: Interpretation, entities: EntityRef[], today: Moment): Clarification | null {
  const find = (slot: Slot, kind: 'missing' | 'multiple') => i.ambiguities.find((a) => a.slot === slot && a.kind === kind);
  const taxMissing = find('tax', 'missing');
  const taxMany = find('tax', 'multiple');
  const periodMissing = find('period', 'missing');
  const periodMany = find('period', 'multiple');
  const who = entitySuffix(i, entities);

  if (taxMany) {
    const options = taxMany.taxes ?? [];
    const names = options.map((k) => TAX_PHRASE[k]).join(' или ');
    return {
      text: `Какой налог посчитать${who}: ${names}?`,
      quick: taxChoices(options),
      awaiting: ['tax'],
    };
  }
  if (periodMany) {
    return {
      text: `Какой период посчитать${who}? Беру один за раз.`,
      quick: periodQuick(periodMany.periods ?? []),
      awaiting: ['period'],
    };
  }
  if (taxMissing && periodMissing) {
    return {
      text: `Какой налог и за какой период посчитать${who}?`,
      quick: [...taxChoices(), ...periodChoices(today)],
      awaiting: ['tax', 'period'],
    };
  }
  if (periodMissing) {
    const tax = i.tax ? TAX_PHRASE[i.tax] : 'налог';
    return {
      text: `За какой период посчитать ${tax}${who}?`,
      quick: periodChoices(today),
      awaiting: ['period'],
    };
  }
  if (taxMissing) {
    return { text: `Какой налог${who}?`, quick: taxChoices(), awaiting: ['tax'] };
  }
  return null;
}
