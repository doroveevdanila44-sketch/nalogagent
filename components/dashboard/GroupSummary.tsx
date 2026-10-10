'use client';

import { useCallback, useState } from 'react';
import {
  dateRu,
  dateRuYear,
  mln,
  pluralRu,
  rub,
  rub2,
  type DashboardInput,
  type LiveModel,
  type Moment,
  type StaticModel,
} from '@/lib/calc';

type CardId = 'revenue' | 'vat' | 'vatForecast' | 'profit';

interface Props {
  moment: Moment;
  input: DashboardInput;
  live: LiveModel;
  stat: StaticModel;
}

const regimeFamily = (r: string) => (r === 'osno' ? 'ОСНО' : 'УСН');

/**
 * Четыре отдельные карточки группы. Нажатие раскрывает расшифровку по юрлицам под карточками,
 * из расшифровки можно перейти к карточкам юрлиц. Живые значения идут из LiveModel.
 */
export function GroupSummary({ moment, input, live, stat }: Props) {
  const [open, setOpen] = useState<CardId | null>(null);
  const { entities } = input;

  const families = [...new Set(entities.map((e) => regimeFamily(e.taxRegime)))];
  const count = entities.length;

  const toggle = useCallback((id: CardId) => setOpen((cur) => (cur === id ? null : id)), []);

  const scrollToEntities = useCallback(() => {
    const el = document.getElementById('entities');
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, []);

  const payerNames = entities.filter((e) => e.status === 'payer');
  const profitEntities = entities.filter((e) => e.taxRegime === 'osno');

  const card = (
    id: CardId,
    label: string,
    value: string,
    sub: React.ReactNode,
  ) => (
    <button
      type="button"
      className={`sum-card ${open === id ? 'open' : ''}`}
      aria-expanded={open === id}
      aria-controls="sum-detail"
      onClick={() => toggle(id)}
    >
      <span className="sum-label">{label}</span>
      <strong className="sum-value">{value}</strong>
      <span className="sum-sub">{sub}</span>
      <svg className="sum-chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7 10 5 5 5-5" />
      </svg>
    </button>
  );

  type Row = { id: string; name: string; color: string; tag: string; value: string };
  const rows: Row[] = [];
  let title = '';
  if (open === 'revenue') {
    title = 'Выручка с начала года по юрлицам';
    for (const e of entities) {
      rows.push({
        id: e.id,
        name: e.name,
        color: e.color,
        tag: e.status === 'payer' ? 'плательщик НДС' : 'освобождено от НДС',
        value: rub(live.perEntity[e.id]!.ytd),
      });
    }
  } else if (open === 'vat') {
    title = 'НДС начислен по выбранным ставкам';
    for (const e of payerNames) {
      const s = stat.perEntity[e.id]!;
      rows.push({
        id: e.id,
        name: e.name,
        color: e.color,
        tag: e.taxRegime === 'osno' ? 'ОСНО, 22% с вычетами' : `ставка ${s.selected}%`,
        value: rub2(live.perEntity[e.id]!.accrued[s.selected]!),
      });
    }
  } else if (open === 'vatForecast') {
    title = 'Прогноз НДС за год по юрлицам';
    for (const e of entities) {
      const s = stat.perEntity[e.id]!;
      rows.push({
        id: e.id,
        name: e.name,
        color: e.color,
        tag: e.status === 'payer' ? (e.taxRegime === 'osno' ? '22% с вычетами' : `ставка ${s.selected}%`) : 'освобождено',
        value: mln(s.forecast[s.selected]!, 2),
      });
    }
  } else if (open === 'profit') {
    title = 'Налог на прибыль и УСН за год по юрлицам';
    for (const e of entities) {
      const t = stat.perEntity[e.id]!.incomeTax;
      rows.push({
        id: e.id,
        name: e.name,
        color: e.color,
        tag: `${t.label}, ${t.ratePct.toString()}%`,
        value: mln(t.forecast, 2),
      });
    }
  }

  return (
    <section className="sum" aria-labelledby="h-group">
      <div className="sum-head">
        <h2 id="h-group">Группа на {dateRuYear(moment)}</h2>
        <p>
          {count} {pluralRu(count, 'юрлицо', 'юрлица', 'юрлиц')} · {families.join(' и ')}
        </p>
      </div>

      <div className="sum-cards">
        {card('revenue', 'Выручка с начала года', rub(live.ytdGroup), 'по всем юрлицам')}
        {card(
          'vat',
          'НДС начислен',
          rub2(live.taxAccruedGroup),
          stat.saving.gt(0) ? `можно сэкономить ${mln(stat.saving, 2)} в год` : 'ставки уже лучшие',
        )}
        {card('vatForecast', 'Прогноз НДС за год', mln(stat.forecastGroup, 2), 'по выбранным ставкам')}
        {card(
          'profit',
          'Налог на прибыль: прогноз за год',
          mln(stat.incomeTaxGroup.profit, 2),
          profitEntities.length
            ? `УСН по остальным юрлицам: ${mln(stat.incomeTaxGroup.usn, 2)} в год`
            : `УСН по группе: ${mln(stat.incomeTaxGroup.usn, 2)} в год`,
        )}
      </div>

      <div id="sum-detail" role="region" aria-label="Расшифровка по юрлицам" hidden={open === null}>
        {open !== null && (
          <div className="sum-detail">
            <h3>{title}</h3>
            <ul>
              {rows.map((r) => (
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
            {open === 'profit' && (
              <p className="sum-note">
                Ближайшие платежи:{' '}
                {entities
                  .map((e) => ({ e, n: stat.perEntity[e.id]!.incomeTax.next }))
                  .filter((x) => x.n)
                  .slice(0, 3)
                  .map((x) => `${x.e.name.replace(/ООО |«|»/g, '')} ${dateRu(x.n!.due)}, ${rub(x.n!.amount)}`)
                  .join('; ')}
                . Суммы ориентировочные, проверьте с бухгалтером.
              </p>
            )}
            <button type="button" className="linkish sum-more" onClick={scrollToEntities}>
              К карточкам юрлиц
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
