import { dateRuYear, mln, pluralRu, rub, rub2, type LiveModel, type Moment, type StaticModel } from '@/lib/calc';

export function GroupBanner({
  moment,
  entityCount,
  live,
  stat,
}: {
  moment: Moment;
  entityCount: number;
  live: LiveModel;
  stat: StaticModel;
}) {
  return (
    <section className="band" aria-label="Группа">
      <div className="band-h">
        <h2>Группа на {dateRuYear(moment)}</h2>
        <span>
          {entityCount} {pluralRu(entityCount, 'юрлицо', 'юрлица', 'юрлиц')} · УСН
        </span>
      </div>
      <div className="metrics">
        <div className="metric">
          <span className="eyebrow">Выручка с начала года</span>
          <strong>{rub(live.ytdGroup)}</strong>
          <small>по всем юрлицам</small>
        </div>
        <div className="metric">
          <span className="eyebrow">НДС начислен</span>
          <strong>{rub2(live.taxAccruedGroup)}</strong>
          <small>плательщики, по выбранным ставкам</small>
        </div>
        <div className="metric">
          <span className="eyebrow">Прогноз НДС за год</span>
          <strong>{mln(stat.forecastGroup, 2)}</strong>
          <small>по выбранным ставкам</small>
        </div>
        <div className="metric">
          <span className="eyebrow">Можно сэкономить</span>
          <strong>{mln(stat.saving, 2)}</strong>
          <small>в год, если выбрать лучшие ставки</small>
        </div>
      </div>
    </section>
  );
}
