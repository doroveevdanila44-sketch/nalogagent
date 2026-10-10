'use client';

import { memo, useCallback, useRef, useState, type KeyboardEvent } from 'react';
import {
  MONTHS_NOMINATIVE,
  MONTHS_SHORT,
  mln,
  type EntityInput,
  type MonthColumn,
} from '@/lib/calc';

const STATUS_LABEL = { fact: 'факт', current: 'идёт сейчас', forecast: 'прогноз' } as const;

interface SegKey {
  month: number;
  /** Индекс юрлица в стопке (0 это нижний сегмент) */
  index: number;
}

const keyOf = (k: SegKey) => `${k.month}:${k.index}`;
const same = (a: SegKey | null, b: SegKey) => a !== null && a.month === b.month && a.index === b.index;

/**
 * График выручки группы по месяцам. Интерактивен сегмент одного юрлица внутри столбца:
 * наведение мышью, касание и фокус с клавиатуры выделяют только его (увеличение, тень),
 * остальные сегменты и столбцы приглушаются. Обводки всего столбца нет.
 * Клавиатура: стрелки влево и вправо меняют месяц, вверх и вниз юрлицо, Home и End крайние месяцы.
 */
function RevenueChartBase({ columns, entities }: { columns: MonthColumn[]; entities: EntityInput[] }) {
  const [hovered, setHovered] = useState<SegKey | null>(null);
  const [focused, setFocused] = useState<SegKey | null>(null);
  const [picked, setPicked] = useState<SegKey | null>(null);
  const currentMonth = Math.max(0, columns.findIndex((c) => c.status === 'current'));
  const [tabKey, setTabKey] = useState(`${currentMonth}:0`);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const active = hovered ?? focused ?? picked;

  const maxTotal = Math.max(...columns.map((c) => c.total.toNumber()));
  // верх оси кратен трём миллионам: три линии сетки делят шкалу поровну
  const top = Math.max(3_000_000, Math.ceil(maxTotal / 3_000_000) * 3_000_000);
  const ticks = [0, top / 3, (top * 2) / 3, top].map((v) => Math.round(v / 1_000_000));

  const nameOf = (index: number) => entities[index]?.name ?? '';

  const moveFocus = useCallback((k: SegKey) => {
    const target = refs.current.get(keyOf(k));
    if (target) {
      setTabKey(keyOf(k));
      target.focus();
    }
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, k: SegKey) => {
      const lastMonth = columns.length - 1;
      const lastIndex = entities.length - 1;
      let next: SegKey | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          next = { month: Math.max(0, k.month - 1), index: k.index };
          break;
        case 'ArrowRight':
          next = { month: Math.min(lastMonth, k.month + 1), index: k.index };
          break;
        case 'ArrowUp':
          next = { month: k.month, index: Math.min(lastIndex, k.index + 1) };
          break;
        case 'ArrowDown':
          next = { month: k.month, index: Math.max(0, k.index - 1) };
          break;
        case 'Home':
          next = { month: 0, index: k.index };
          break;
        case 'End':
          next = { month: lastMonth, index: k.index };
          break;
        case 'Escape':
          setPicked(null);
          return;
      }
      if (next) {
        e.preventDefault();
        moveFocus(next);
      }
    },
    [columns.length, entities.length, moveFocus],
  );

  const activeColumn = active ? columns[active.month] : null;
  const activeAmount = active && activeColumn ? activeColumn.byEntity[active.index] : null;

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
        <div className="plot" data-active={active ? 'true' : undefined}>
          {columns.map((c) => (
            <div
              key={c.month}
              role="group"
              className={`col ${c.status === 'forecast' ? 'fc' : ''}`}
              aria-label={`${MONTHS_NOMINATIVE[c.month]}: ${mln(c.total, 1)}, ${STATUS_LABEL[c.status]}`}
            >
              {c.byEntity.map((b, index) => {
                const k: SegKey = { month: c.month, index };
                const id = keyOf(k);
                return (
                  <button
                    key={b.id}
                    type="button"
                    ref={(el) => {
                      if (el) refs.current.set(id, el);
                      else refs.current.delete(id);
                    }}
                    className={`seg ${same(active, k) ? 'on' : ''}`}
                    style={{
                      height: `${((b.amount.toNumber() / top) * 100).toFixed(2)}%`,
                      background: entities[index]?.color,
                    }}
                    aria-label={`${nameOf(index)}, ${MONTHS_NOMINATIVE[c.month]}: ${mln(b.amount, 2)}, ${STATUS_LABEL[c.status]}`}
                    aria-pressed={same(picked, k)}
                    tabIndex={tabKey === id ? 0 : -1}
                    onPointerEnter={(e) => {
                      if (e.pointerType === 'mouse') setHovered(k);
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === 'mouse') setHovered(null);
                    }}
                    onFocus={(e) => {
                      // фокус с клавиатуры подсвечивает сегмент, фокус после клика мышью нет
                      let keyboard = true;
                      try {
                        keyboard = e.currentTarget.matches(':focus-visible');
                      } catch {
                        // старый браузер без :focus-visible: считаем фокус клавиатурным
                      }
                      if (keyboard) setFocused(k);
                      setTabKey(id);
                    }}
                    onBlur={() => setFocused(null)}
                    onClick={() => {
                      setPicked(same(picked, k) ? null : k);
                      setTabKey(id);
                    }}
                    onKeyDown={(e) => onKeyDown(e, k)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mon" aria-hidden="true">
        {MONTHS_SHORT.map((m, i) => (
          <span key={m} className={i === currentMonth ? 'now' : undefined}>
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
        {active && activeColumn && activeAmount
          ? `${nameOf(active.index)}, ${MONTHS_NOMINATIVE[active.month]!.toLowerCase()}: ${mln(activeAmount.amount, 2)} (${STATUS_LABEL[activeColumn.status]}).`
          : 'Наведите или нажмите на сегмент, чтобы увидеть юрлицо и сумму.'}
      </p>
    </>
  );
}

export const RevenueChart = memo(RevenueChartBase);
