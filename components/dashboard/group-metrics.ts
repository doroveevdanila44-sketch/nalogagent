import {
  mln,
  pluralRu,
  rub,
  rub2,
  type EntityInput,
  type LiveModel,
  type StaticModel,
} from '@/lib/calc';

export type GroupMetricId = 'revenue' | 'vat' | 'vatForecast' | 'profit';

export interface GroupMetric {
  id: GroupMetricId;
  label: string;
  value: string;
  sub: string;
}

const regimeFamily = (r: string) => (r === 'osno' ? 'ОСНО' : 'УСН');

/**
 * Четыре показателя группы. Один источник для двух видов: четыре отдельных баннера (телефон,
 * планшет) и один широкий баннер группы (от 1024 px).
 */
export function groupMetrics(live: LiveModel, stat: StaticModel, entities: EntityInput[]): GroupMetric[] {
  const hasOsno = entities.some((e) => e.taxRegime === 'osno');
  return [
    { id: 'revenue', label: 'Выручка с начала года', value: rub(live.ytdGroup), sub: 'по всем юрлицам' },
    {
      id: 'vat',
      label: 'НДС начислен',
      value: rub2(live.taxAccruedGroup),
      sub: stat.saving.gt(0) ? `можно сэкономить ${mln(stat.saving, 2)} в год` : 'ставки уже лучшие',
    },
    {
      id: 'vatForecast',
      label: 'Прогноз НДС за год',
      value: mln(stat.forecastGroup, 2),
      sub: 'по выбранным ставкам',
    },
    {
      id: 'profit',
      label: 'Налог на прибыль: прогноз за год',
      value: mln(stat.incomeTaxGroup.profit, 2),
      sub: hasOsno
        ? `УСН по остальным юрлицам: ${mln(stat.incomeTaxGroup.usn, 2)} в год`
        : `УСН по группе: ${mln(stat.incomeTaxGroup.usn, 2)} в год`,
    },
  ];
}

/** Подпись справа от заголовка группы: «5 юрлиц · УСН и ОСНО» */
export function groupCaption(entities: EntityInput[]): string {
  const families = [...new Set(entities.map((e) => regimeFamily(e.taxRegime)))];
  const count = entities.length;
  return `${count} ${pluralRu(count, 'юрлицо', 'юрлица', 'юрлиц')} · ${families.join(' и ')}`;
}
