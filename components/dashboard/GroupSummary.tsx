'use client';

import { useCallback, useState } from 'react';
import { entityColor } from '@/lib/theme';
import {
  dateRu,
  dateRuYear,
  mln,
  rub,
  rub2,
  type DashboardInput,
  type LiveModel,
  type Moment,
  type StaticModel,
} from '@/lib/calc';
import { groupCaption, groupMetrics, type GroupMetricId } from './group-metrics';

type CardId = GroupMetricId;

interface Props {
  moment: Moment;
  input: DashboardInput;
  live: LiveModel;
  stat: StaticModel;
}

/**
 * Четыре отдельные карточки группы. Нажатие раскрывает расшифровку по юрлицам прямо под нажатой
 * карточкой, как часть списка: остальные карточки плавно съезжают вниз. Раскрыта может быть одна,
 * при открытии другой прежняя закрывается одновременно. Из расшифровки можно перейти к карточкам
 * юрлиц. Живые значения идут из LiveModel.
 */
export function GroupSummary({ moment, input, live, stat }: Props) {
  const [open, setOpen] = useState<CardId | null>(null);
  const { entities } = input;

  const toggle = useCallback((id: CardId) => setOpen((cur) => (cur === id ? null : id)), []);

  const scrollToEntities = useCallback(() => {
    const el = document.getElementById('entities');
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, []);

  const payerNames = entities.filter((e) => e.status === 'payer');

  type Row = { id: string; name: string; color: string; tag: string; value: string };
  const detail: Record<CardId, { title: string; rows: Row[] }> = {
    revenue: {
      title: 'Выручка с начала года по юрлицам',
      rows: entities.map((e) => ({
        id: e.id,
        name: e.name,
        color: entityColor(e),
        tag: e.status === 'payer' ? 'плательщик НДС' : 'освобождено от НДС',
        value: rub(live.perEntity[e.id]!.ytd),
      })),
    },
    vat: {
      title: 'НДС начислен по выбранным ставкам',
      rows: payerNames.map((e) => {
        const s = stat.perEntity[e.id]!;
        return {
          id: e.id,
          name: e.name,
          color: entityColor(e),
          tag: e.taxRegime === 'osno' ? 'ОСНО, 22% с вычетами' : `ставка ${s.selected}%`,
          value: rub2(live.perEntity[e.id]!.accrued[s.selected]!),
        };
      }),
    },
    vatForecast: {
      title: 'Прогноз НДС за год по юрлицам',
      rows: entities.map((e) => {
        const s = stat.perEntity[e.id]!;
        return {
          id: e.id,
          name: e.name,
          color: entityColor(e),
          tag: e.status === 'payer' ? (e.taxRegime === 'osno' ? '22% с вычетами' : `ставка ${s.selected}%`) : 'освобождено',
          value: mln(s.forecast[s.selected]!, 2),
        };
      }),
    },
    profit: {
      title: 'Налог на прибыль и УСН за год по юрлицам',
      rows: entities.map((e) => {
        const t = stat.perEntity[e.id]!.incomeTax;
        return {
          id: e.id,
          name: e.name,
          color: entityColor(e),
          tag: `${t.label}, ${t.ratePct.toString()}%`,
          value: mln(t.forecast, 2),
        };
      }),
    },
  };

  const profitNote =
    'Ближайшие платежи: ' +
    entities
      .map((e) => ({ e, n: stat.perEntity[e.id]!.incomeTax.next }))
      .filter((x) => x.n)
      .slice(0, 3)
      .map((x) => `${x.e.name.replace(/ООО |«|»/g, '')} ${dateRu(x.n!.due)}, ${rub(x.n!.amount)}`)
      .join('; ') +
    '. Суммы ориентировочные, проверьте с бухгалтером.';

  /** Карточка и её расшифровка в одной ячейке списка */
  const item = ({ id, label, value, sub }: { id: CardId; label: string; value: string; sub: string }) => {
    const isOpen = open === id;
    const d = detail[id];
    return (
      <div key={id} className={`sum-item ${isOpen ? 'open' : ''}`}>
        <button
          type="button"
          id={`sum-btn-${id}`}
          className={`sum-card ${isOpen ? 'open' : ''}`}
          aria-expanded={isOpen}
          aria-controls={`sum-detail-${id}`}
          onClick={() => toggle(id)}
        >
          <span className="sum-label">{label}</span>
          <strong className="sum-value">{value}</strong>
          <span className="sum-sub">{sub}</span>
          <svg className="sum-chev" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        <div
          id={`sum-detail-${id}`}
          className="acc"
          data-open={isOpen}
          role="region"
          aria-labelledby={`sum-btn-${id}`}
        >
          <div className="acc-in" inert={!isOpen}>
            <div className="sum-detail acc-body">
              <h3>{d.title}</h3>
              <ul>
                {d.rows.map((r) => (
                  <li key={r.id}>
                    <span className="sum-row-name">
                      <i style={{ background: r.color }} />
                      <span>
                        {r.name}
                        <small>{r.tag}</small>
                      </span>
                    </span>
                    <b>{r.value}</b>
                  </li>
                ))}
              </ul>
              {id === 'profit' && <p className="sum-note">{profitNote}</p>}
              <button type="button" className="sum-more" onClick={scrollToEntities}>
                К карточкам юрлиц
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="sum" aria-labelledby="h-group">
      <div className="sum-head">
        <h2 id="h-group">Группа на {dateRuYear(moment)}</h2>
        <p>{groupCaption(entities)}</p>
      </div>

      <div className="sum-cards">{groupMetrics(live, stat, entities).map((m) => item(m))}</div>
    </section>
  );
}
