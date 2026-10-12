import {
  MONTHS_NOMINATIVE,
  ZERO,
  mln,
  type DashboardInput,
  type LiveModel,
  type StaticModel,
} from '@/lib/calc';
import { factPlusRest } from '@/components/dashboard/group-metrics';
import type { TourNumbers } from './chapters';

/** «Эпсилон» из «ООО «Эпсилон»»; «ИП Бета» остаётся как есть */
const shortName = (name: string) => name.replace(/ООО |«|»/g, '');

/**
 * Числа для строк обучения. Всё берётся из тех же моделей, что рисуют дашборд (computeStatic и
 * computeLive над результатами calcTax), поэтому число в карточке совпадает с баннером; своих
 * формул здесь нет. Живая выручка и начисленный НДС растут каждую секунду, в карточке они
 * показаны на момент шага с точностью до сотых долей миллиона.
 */
export function tourNumbers(input: DashboardInput, stat: StaticModel, live: LiveModel, year: number): TourNumbers {
  const { entities } = input;
  const rules = input.ctx.rules;
  const osno = entities.filter((e) => e.taxRegime === 'osno');
  const profitFact = osno.reduce((acc, e) => acc.plus(live.perEntity[e.id]?.incomeTaxAccrued ?? ZERO), ZERO);

  let best: { month: number; total: StaticModel['columns'][number]['total'] } | null = null;
  for (const c of stat.columns) {
    if (best === null || c.total.gt(best.total)) best = { month: c.month, total: c.total };
  }

  // те же юрлица, что подсвечивает интерфейс: первое освобождённое не на ОСНО и первый плательщик с выбором ставки
  const exempt = entities.find((e) => e.status !== 'payer' && e.taxRegime !== 'osno');
  const payer = entities.find((e) => e.status === 'payer' && e.taxRegime !== 'osno');

  return {
    year,
    revenue: mln(live.ytdGroup, 2),
    vatAccrued: mln(live.taxAccruedGroup, 2),
    vatForecast: mln(stat.forecastGroup, 2),
    vatSplit: factPlusRest(live.taxAccruedGroup, stat.forecastGroup),
    profit: mln(stat.incomeTaxGroup.profit, 2),
    usn: mln(stat.incomeTaxGroup.usn, 2),
    osno: osno.length > 0 ? osno.map((e) => shortName(e.name)).join(', ') : null,
    warningsTotal: stat.warnings.length,
    warningsUrgent: stat.warnings.filter((w) => w.level === 'crit').length,
    bestMonth: best ? { name: MONTHS_NOMINATIVE[best.month]!.toLowerCase(), value: mln(best.total, 2) } : null,
    threshold: mln(rules.vatExemptLimit, 0),
    exempt: exempt
      ? {
          name: exempt.name,
          ytd: mln(live.perEntity[exempt.id]!.ytd, 2),
          limit: mln(rules.vatExemptLimit, 0),
        }
      : null,
    rates: payer
      ? {
          name: shortName(payer.name),
          items: rules.rates.map((r) => ({ rate: r, sum: mln(live.perEntity[payer.id]!.accrued[r] ?? ZERO, 2) })),
        }
      : null,
  };
}
