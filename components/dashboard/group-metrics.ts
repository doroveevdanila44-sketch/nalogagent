import {
  ZERO,
  mln,
  pluralRu,
  rub,
  rub2,
  type Dec,
  type EntityInput,
  type LiveModel,
  type StaticModel,
} from '@/lib/calc';

export type GroupMetricId = 'revenue' | 'vat' | 'vatForecast' | 'profit';

export interface GroupMetric {
  id: GroupMetricId;
  label: string;
  /** Отметка рядом с подписью: «прогноз» */
  tag: string | null;
  value: string;
  /** Строки пояснения под суммой; пусто, если сказать нечего сверх заголовка и цвета */
  sub: string[];
}

const regimeFamily = (r: string) => (r === 'osno' ? 'ОСНО' : 'УСН');

/** Миллионы с двумя знаками из рублей: целое число копеек в миллионах, чтобы части складывались ровно. */
const cents = (d: Dec) => d.div(1_000_000).toDecimalPlaces(2);

/**
 * «факт 6,75 млн + остаток 1,65 млн»: факт с начала года и прогноз остатка года по сезонности. Остаток
 * считается как разность округлённых итога и факта, поэтому на экране части в сумме дают итог.
 */
export function factPlusRest(fact: Dec, total: Dec): string {
  const f = cents(fact);
  const diff = cents(total).minus(f);
  const rest = diff.lt(0) ? ZERO : diff;
  const t = (x: Dec) => mln(x.times(1_000_000), 2);
  return `факт ${t(f)} + остаток ${t(rest)}`;
}

/** «Эпсилон» из «ООО «Эпсилон»» */
const shortName = (name: string) => name.replace(/ООО |«|»/g, '');

/**
 * Четыре показателя группы. Один источник для двух видов: четыре отдельных баннера (телефон,
 * планшет) и один широкий баннер группы (от 1024 px). «НДС за 2026 год» и «Налог на прибыль за
 * 2026 год» это прогноз года: под значением факт с начала года и остаток; факт идёт из того же
 * расчёта, что баннер «НДС начислен» (calcTax за период «с начала года»).
 */
export function groupMetrics(
  live: LiveModel,
  stat: StaticModel,
  entities: EntityInput[],
  year: number,
): GroupMetric[] {
  const osno = entities.filter((e) => e.taxRegime === 'osno');
  const hasOsno = osno.length > 0;
  const profitFact = osno.reduce((acc, e) => acc.plus(live.perEntity[e.id]?.incomeTaxAccrued ?? ZERO), ZERO);
  const profitSub = hasOsno
    ? [
        `${osno.map((e) => shortName(e.name)).join(', ')}, ОСНО: ${factPlusRest(profitFact, stat.incomeTaxGroup.profit)}`,
        `УСН по остальным: ${mln(stat.incomeTaxGroup.usn, 2)}`,
      ]
    : [`УСН по группе: ${mln(stat.incomeTaxGroup.usn, 2)}`];
  return [
    { id: 'revenue', label: 'Выручка с начала года', tag: null, value: rub(live.ytdGroup), sub: [] },
    {
      id: 'vat',
      label: 'НДС начислен',
      tag: null,
      value: rub2(live.taxAccruedGroup),
      sub: stat.saving.gt(0) ? [`можно сэкономить ${mln(stat.saving, 2)} в год`] : [],
    },
    {
      id: 'vatForecast',
      label: `НДС за ${year} год`,
      tag: 'прогноз',
      value: mln(stat.forecastGroup, 2),
      sub: [factPlusRest(live.taxAccruedGroup, stat.forecastGroup)],
    },
    {
      id: 'profit',
      label: `Налог на прибыль за ${year} год`,
      tag: 'прогноз',
      value: mln(stat.incomeTaxGroup.profit, 2),
      sub: profitSub,
    },
  ];
}

/** Подпись справа от заголовка группы: «5 юрлиц · УСН и ОСНО» */
export function groupCaption(entities: EntityInput[]): string {
  const families = [...new Set(entities.map((e) => regimeFamily(e.taxRegime)))];
  const count = entities.length;
  return `${count} ${pluralRu(count, 'юрлицо', 'юрлица', 'юрлиц')} · ${families.join(' и ')}`;
}
