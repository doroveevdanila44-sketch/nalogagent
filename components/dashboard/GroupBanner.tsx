import { dateRuYear, type DashboardInput, type LiveModel, type Moment, type StaticModel } from '@/lib/calc';
import { groupCaption, groupMetrics } from './group-metrics';

interface Props {
  moment: Moment;
  input: DashboardInput;
  live: LiveModel;
  stat: StaticModel;
}

/**
 * Один широкий баннер группы для компьютера (от 1024 px): заголовок «Группа на <дата>», справа
 * «5 юрлиц · режимы», внутри четыре показателя в одном ряду. Это первый вид баннера из первой
 * версии приложения. Как и тогда, он не раскрывается: расшифровка по юрлицам есть в карточках
 * юрлиц и на графике ниже. Ниже 1024 px вместо него четыре отдельных баннера (GroupSummary).
 */
export function GroupBanner({ moment, input, live, stat }: Props) {
  const metrics = groupMetrics(live, stat, input.entities);
  return (
    <section className="band" aria-labelledby="h-group">
      <div className="band-h">
        <h2 id="h-group">Группа на {dateRuYear(moment)}</h2>
        <span>{groupCaption(input.entities)}</span>
      </div>
      <div className="metrics">
        {metrics.map((m) => (
          <div className="metric" key={m.id}>
            <span className="eyebrow">{m.label}</span>
            <strong>{m.value}</strong>
            <small>{m.sub}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
