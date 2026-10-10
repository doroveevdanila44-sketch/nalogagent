'use client';

import { memo, useState } from 'react';
import {
  MONTHS_NOMINATIVE,
  MONTHS_SHORT,
  mln,
  type EntityInput,
  type MonthColumn,
} from '@/lib/calc';

const STATUS_LABEL = { fact: 'факт', current: 'идёт сейчас', forecast: 'прогноз' } as const;

/** Столбцы это кнопки с aria-label. Прошедшие месяцы сплошные, будущие со штриховкой, текущий выделен. */
function RevenueChartBase({ columns, entities }: { columns: MonthColumn[]; entities: EntityInput[] }) {
  const [picked, setPicked] = useState<number | null>(null);

  const maxTotal = Math.max(...columns.map((c) => c.total.toNumber()));
  // верх оси кратен трём миллионам: три линии сетки делят шкалу поровну
  const top = Math.max(3_000_000, Math.ceil(maxTotal / 3_000_000) * 3_000_000);
  const ticks = [0, top / 3, (top * 2) / 3, top].map((v) => Math.round(v / 1_000_000));
  const color = new Map(entities.map((e) => [e.id, e.color]));
  const current = columns.find((c) => c.status === 'current')?.month ?? -1;

  const shortName = (name: string) => name.replace(/ООО |«|»/g, '');
  const col = picked !== null ? columns[picked] : null;

  return (
    <>
      <div className="sec-h">
        <h2 id="h-chart">Выручка группы по месяцам</h2>
        <p>Факт и прогноз с учётом сезонности, млн ₽</p>
      </div>
      <div className="chart">
        <div className="yax" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="plot">
          {columns.map((c) => (
            <button
              key={c.month}
              type="button"
              className={`col ${c.status === 'forecast' ? 'fc' : ''} ${c.status === 'current' ? 'cur' : ''}`}
              aria-pressed={picked === c.month}
              aria-label={`${MONTHS_NOMINATIVE[c.month]}: ${mln(c.total, 1)}, ${STATUS_LABEL[c.status]}`}
              onClick={() => setPicked(picked === c.month ? null : c.month)}
            >
              {c.byEntity.map((b) => (
                <span
                  key={b.id}
                  className="seg"
                  style={{
                    height: `${((b.amount.toNumber() / top) * 100).toFixed(2)}%`,
                    background: color.get(b.id),
                  }}
                />
              ))}
            </button>
          ))}
        </div>
      </div>
      <div className="mon" aria-hidden="true">
        {MONTHS_SHORT.map((m, i) => (
          <span key={m} className={i === current ? 'now' : undefined}>
            {m}
          </span>
        ))}
      </div>
      <div className="legend">
        {entities.map((e) => (
          <span key={e.id}>
            <i style={{ background: e.color }} />
            {e.name}
          </span>
        ))}
        <span style={{ color: 'var(--color-muted)' }}>Штриховка: прогноз</span>
      </div>
      <p className="caption" aria-live="polite">
        {col
          ? `${MONTHS_NOMINATIVE[col.month]}: ${mln(col.total, 1)} (${STATUS_LABEL[col.status]}). ` +
            col.byEntity
              .map((b) => `${shortName(entities.find((e) => e.id === b.id)?.name ?? b.id)} ${mln(b.amount, 1)}`)
              .join(', ') +
            '.'
          : 'Нажмите на месяц, чтобы увидеть сумму.'}
      </p>
    </>
  );
}

export const RevenueChart = memo(RevenueChartBase);
