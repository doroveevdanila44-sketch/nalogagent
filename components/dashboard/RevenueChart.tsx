'use client';

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { entityColor } from '@/lib/theme';
import {
  MONTHS_NOMINATIVE,
  MONTHS_SHORT,
  mln,
  type EntityInput,
  type MonthColumn,
} from '@/lib/calc';

const STATUS_LABEL = { fact: 'факт', current: 'идёт сейчас', forecast: 'прогноз' } as const;

/** Выделение на графике: сегмент юрлица (index) или весь столбец месяца (index = null) */
interface Sel {
  month: number;
  /** Индекс юрлица в стопке (0 это нижний сегмент); null: выделен весь столбец */
  index: number | null;
}

const segId = (month: number, index: number) => `${month}:${index}`;
const same = (a: Sel | null, month: number, index: number | null) =>
  a !== null && a.month === month && a.index === index;

/**
 * График выручки группы по месяцам. На телефоне ось Y закреплена слева, столбцы в
 * горизонтально прокручиваемом контейнере (столбец от 40 px, график около 520 px, прокрутка со
 * снапом, при открытии текущий месяц по центру).
 *
 * Два вида выделения. Сегмент юрлица: наведение мышью, касание и клавиатура выделяют только его,
 * остальные приглушаются, подпись под графиком показывает юрлицо, месяц и сумму. Весь столбец:
 * нажатие на подпись месяца под столбцом или на пустую область над ним (область нажатия на всю
 * высоту столбца), на компьютере ещё наведение на подпись месяца. Все сегменты подсвечиваются,
 * остальные столбцы приглушаются до 45 процентов, столбец плавно увеличивается, подпись показывает
 * месяц, итог столбца и разбивку по юрлицам. Повторное нажатие снимает выделение.
 *
 * Клавиатура: сегменты и подписи месяцев это кнопки с aria-label. В сегментах стрелки влево и
 * вправо меняют месяц, вверх и вниз юрлицо (вниз с нижнего сегмента на подпись месяца), Home и End
 * крайние месяцы. В подписях месяцев стрелки влево и вправо, вверх к сегментам, Enter и пробел
 * выделяют столбец, Escape снимает выделение.
 */
function RevenueChartBase({ columns, entities }: { columns: MonthColumn[]; entities: EntityInput[] }) {
  const [hovered, setHovered] = useState<Sel | null>(null);
  const [focused, setFocused] = useState<Sel | null>(null);
  const [picked, setPicked] = useState<Sel | null>(null);
  const currentMonth = Math.max(0, columns.findIndex((c) => c.status === 'current'));
  const [tabKey, setTabKey] = useState(segId(currentMonth, 0));
  const [monTab, setMonTab] = useState(currentMonth);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const monRefs = useRef(new Map<number, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);

  const active = hovered ?? focused ?? picked;
  const activeSeg = active && active.index !== null ? { month: active.month, index: active.index } : null;
  const activeCol = active && active.index === null ? active.month : null;

  const maxTotal = Math.max(...columns.map((c) => c.total.toNumber()));
  // верх оси кратен трём миллионам: три линии сетки делят шкалу поровну
  const top = Math.max(3_000_000, Math.ceil(maxTotal / 3_000_000) * 3_000_000);
  const ticks = [0, top / 3, (top * 2) / 3, top].map((v) => Math.round(v / 1_000_000));

  const nameOf = (index: number) => entities[index]?.name ?? '';

  // При открытии текущий месяц по центру видимой области. Если месяц близок к концу ленты и
  // прокрутки не хватает, справа добавляется ровно нужный запас.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const inner = sc.firstElementChild as HTMLElement | null;
    const col = sc.querySelectorAll<HTMLElement>('.col')[currentMonth];
    if (!inner || !col) return;
    inner.style.paddingRight = '0px';
    const target = col.offsetLeft + col.offsetWidth / 2 - sc.clientWidth / 2;
    const maxLeft = sc.scrollWidth - sc.clientWidth;
    if (target > maxLeft) inner.style.paddingRight = `${Math.ceil(target - maxLeft)}px`;
    sc.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
  }, [currentMonth]);

  /**
   * Касание у тонких сегментов попадает в расширенную область соседа. Выбранный сегмент
   * определяется по точке: тот, внутри которого она лежит, иначе ближайший по вертикали.
   */
  const resolveByPoint = useCallback((btn: HTMLElement, clientY: number, fallback: Sel): Sel => {
    const col = btn.parentElement;
    if (!col) return fallback;
    const segs = [...col.querySelectorAll<HTMLElement>('button.seg')];
    let best = fallback;
    let bestDist = Infinity;
    segs.forEach((el, index) => {
      const r = el.getBoundingClientRect();
      const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      if (d < bestDist) {
        bestDist = d;
        best = { month: fallback.month, index };
      }
    });
    return best;
  }, []);

  const moveFocus = useCallback((month: number, index: number) => {
    const target = refs.current.get(segId(month, index));
    if (target) {
      setTabKey(segId(month, index));
      target.focus();
    }
  }, []);

  const focusMonth = useCallback((month: number) => {
    const target = monRefs.current.get(month);
    if (target) {
      setMonTab(month);
      target.focus();
    }
  }, []);

  const toggleColumn = useCallback((month: number) => {
    setPicked((cur) => (same(cur, month, null) ? null : { month, index: null }));
    setMonTab(month);
  }, []);

  const onSegKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, month: number, index: number) => {
      const lastMonth = columns.length - 1;
      const lastIndex = entities.length - 1;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          moveFocus(Math.max(0, month - 1), index);
          return;
        case 'ArrowRight':
          e.preventDefault();
          moveFocus(Math.min(lastMonth, month + 1), index);
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(month, Math.min(lastIndex, index + 1));
          return;
        case 'ArrowDown':
          e.preventDefault();
          if (index === 0) focusMonth(month);
          else moveFocus(month, index - 1);
          return;
        case 'Home':
          e.preventDefault();
          moveFocus(0, index);
          return;
        case 'End':
          e.preventDefault();
          moveFocus(lastMonth, index);
          return;
        case 'Escape':
          setPicked(null);
          return;
      }
    },
    [columns.length, entities.length, moveFocus, focusMonth],
  );

  const onMonKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, month: number) => {
      const lastMonth = columns.length - 1;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          focusMonth(Math.max(0, month - 1));
          return;
        case 'ArrowRight':
          e.preventDefault();
          focusMonth(Math.min(lastMonth, month + 1));
          return;
        case 'Home':
          e.preventDefault();
          focusMonth(0);
          return;
        case 'End':
          e.preventDefault();
          focusMonth(lastMonth);
          return;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(month, 0);
          return;
        case 'Escape':
          setPicked(null);
          return;
      }
    },
    [columns.length, focusMonth, moveFocus],
  );

  /** Фокус с клавиатуры подсвечивает, фокус после клика мышью нет */
  const isKeyboardFocus = (el: HTMLElement) => {
    try {
      return el.matches(':focus-visible');
    } catch {
      // старый браузер без :focus-visible: считаем фокус клавиатурным
      return true;
    }
  };

  const activeColumn = active ? columns[active.month] : null;
  const activeAmount = activeSeg && activeColumn ? activeColumn.byEntity[activeSeg.index] : null;
  const activeEntity = activeSeg ? entities[activeSeg.index] : null;
  const monthCaption = (month: number) => MONTHS_NOMINATIVE[month]!;

  return (
    <>
      <div className="sec-h">
        <h2 id="h-chart">Выручка группы по месяцам</h2>
        <p>Факт и прогноз с учётом сезонности, млн ₽</p>
      </div>
      <div className="chart" data-tour="chart">
        <div className="yax" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="plot-scroll" ref={scroller}>
          <div className="plot-inner">
            <div
              className="plot"
              data-active={activeSeg ? 'true' : undefined}
              data-col={activeCol !== null ? 'true' : undefined}
            >
              {columns.map((c) => (
                <div
                  key={c.month}
                  role="group"
                  className={`col ${c.status === 'forecast' ? 'fc' : ''} ${activeCol === c.month ? 'sel' : ''}`}
                  aria-label={`${MONTHS_NOMINATIVE[c.month]}: ${mln(c.total, 1)}, ${STATUS_LABEL[c.status]}`}
                >
                  {/* пустая область над сегментами: нажатие выделяет весь столбец (с клавиатуры подпись месяца) */}
                  <div className="col-hit" aria-hidden="true" onClick={() => toggleColumn(c.month)} />
                  {c.byEntity.map((b, index) => {
                    const id = segId(c.month, index);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        ref={(el) => {
                          if (el) refs.current.set(id, el);
                          else refs.current.delete(id);
                        }}
                        className={`seg ${same(active, c.month, index) ? 'on' : ''}`}
                        style={
                          {
                            '--share': (b.amount.toNumber() / top).toFixed(5),
                            background: entities[index] ? entityColor(entities[index]) : undefined,
                          } as React.CSSProperties
                        }
                        aria-label={`${nameOf(index)}, ${MONTHS_NOMINATIVE[c.month]}: ${mln(b.amount, 2)}, ${STATUS_LABEL[c.status]}`}
                        aria-pressed={same(picked, c.month, index)}
                        tabIndex={tabKey === id ? 0 : -1}
                        onPointerEnter={(e) => {
                          if (e.pointerType === 'mouse') setHovered({ month: c.month, index });
                        }}
                        onPointerLeave={(e) => {
                          if (e.pointerType === 'mouse') setHovered(null);
                        }}
                        onFocus={(e) => {
                          if (isKeyboardFocus(e.currentTarget)) setFocused({ month: c.month, index });
                          setTabKey(id);
                        }}
                        onBlur={() => setFocused(null)}
                        onClick={(e) => {
                          // detail 0: клавиатура, свой сегмент; иначе точка касания
                          const target =
                            e.detail > 0
                              ? resolveByPoint(e.currentTarget, e.clientY, { month: c.month, index })
                              : { month: c.month, index };
                          setPicked(same(picked, target.month, target.index) ? null : target);
                          setTabKey(segId(target.month, target.index!));
                        }}
                        onKeyDown={(e) => onSegKeyDown(e, c.month, index)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mon" role="group" aria-label="Месяцы: нажмите, чтобы выделить весь столбец">
              {columns.map((c) => (
                <button
                  key={c.month}
                  type="button"
                  ref={(el) => {
                    if (el) monRefs.current.set(c.month, el);
                    else monRefs.current.delete(c.month);
                  }}
                  className="mon-btn"
                  aria-label={`${monthCaption(c.month)}: ${mln(c.total, 1)}, ${STATUS_LABEL[c.status]}. Выделить весь столбец`}
                  aria-pressed={same(picked, c.month, null)}
                  tabIndex={monTab === c.month ? 0 : -1}
                  onPointerEnter={(e) => {
                    if (e.pointerType === 'mouse') setHovered({ month: c.month, index: null });
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === 'mouse') setHovered(null);
                  }}
                  // фокус только ставит точку входа клавиатуры: столбец выделяют Enter и пробел, так
                  // повторное нажатие видно (иначе фокус подсвечивал бы столбец и после снятия)
                  onFocus={() => setMonTab(c.month)}
                  onClick={() => toggleColumn(c.month)}
                  onKeyDown={(e) => onMonKeyDown(e, c.month)}
                >
                  <span className={c.month === currentMonth ? 'now' : undefined}>{MONTHS_SHORT[c.month]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="legend">
        {entities.map((e) => (
          <span key={e.id}>
            <i style={{ background: entityColor(e) }} />
            {e.name}
          </span>
        ))}
        <span className="legend-note">Штриховка: прогноз</span>
      </div>

      <div className="seg-card" aria-live="polite" aria-atomic="true">
        {activeSeg && activeColumn && activeAmount && activeEntity ? (
          <>
            <span className="seg-dot" style={{ background: entityColor(activeEntity) }} />
            <div className="seg-text">
              <span className="seg-name">{activeEntity.name}</span>
              <span className="seg-meta">
                {monthCaption(activeSeg.month).toLowerCase()} · {STATUS_LABEL[activeColumn.status]}
              </span>
            </div>
            <strong className="seg-amount">{mln(activeAmount.amount, 2)}</strong>
          </>
        ) : activeCol !== null && activeColumn ? (
          <div className="seg-col">
            <div className="seg-col-head">
              <div className="seg-text">
                <span className="seg-name">{monthCaption(activeCol)}, весь столбец</span>
                <span className="seg-meta">итог месяца · {STATUS_LABEL[activeColumn.status]}</span>
              </div>
              <strong className="seg-amount">{mln(activeColumn.total, 2)}</strong>
            </div>
            <ul className="seg-split">
              {entities.map((e, index) => (
                <li key={e.id}>
                  <span className="seg-split-name">
                    <i style={{ background: entityColor(e) }} />
                    {e.name}
                  </span>
                  <b>{mln(activeColumn.byEntity[index]!.amount, 2)}</b>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <span className="seg-hint">
            Наведите или нажмите на сегмент, чтобы увидеть юрлицо, месяц и сумму. Нажмите на подпись месяца,
            чтобы выделить весь столбец.
          </span>
        )}
      </div>
    </>
  );
}

export const RevenueChart = memo(RevenueChartBase);
