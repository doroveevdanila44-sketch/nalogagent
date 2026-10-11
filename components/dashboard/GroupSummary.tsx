'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/lib/client/media';
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
import { CalcActions } from '@/components/provenance/CalcActions';
import { SourceLine } from '@/components/provenance/SourceLine';
import type { SourceLineData } from '@/lib/provenance/line';
import { bannerQueries } from '@/lib/provenance/dashboard';
import { groupCaption, groupMetrics, type GroupMetricId } from './group-metrics';

type CardId = GroupMetricId;

interface Props {
  moment: Moment;
  input: DashboardInput;
  live: LiveModel;
  stat: StaticModel;
  /** Строки происхождения под баннерами (из результатов calcTax) */
  lines: Record<GroupMetricId, SourceLineData>;
  /** Год расчёта: для запросов «за год» */
  year: number;
  /** Момент (мс UTC), на который сейчас показаны цифры */
  getAt: () => number;
}

/**
 * Общая панель расшифровки под рядом карточек (компьютер, от 1024 px). Высота плавно растёт и
 * сворачивается за 450 мс: панель измеряет содержимое и ставит его высоту, поэтому при переходе от
 * одной карточки к другой высота тоже меняется плавно, а новое содержимое мягко проявляется.
 * Пока панель закрывается, показывается последнее содержимое: оно обрезается высотой.
 */
function SumPanel({ openId, render }: { openId: CardId | null; render: (id: CardId) => ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [shown, setShown] = useState<CardId | null>(openId);
  if (openId !== null && openId !== shown) setShown(openId);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  return (
    <div
      id="sum-panel"
      className="sum-panel"
      role="region"
      aria-labelledby={shown ? `sum-btn-${shown}` : undefined}
      inert={openId === null}
      style={{ height: openId === null ? 0 : height }}
    >
      {shown ? (
        <div key={shown} ref={bodyRef} className="sum-panel-in">
          {render(shown)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Четыре отдельные карточки группы на всех ширинах: на телефоне колонкой, на планшете два на два,
 * от 1024 px в один ряд. Над ними строка «Группа на <дата>» и «5 юрлиц · режимы» без фона.
 *
 * Раскрытие: на телефоне и планшете расшифровка по юрлицам раскрывается по месту, прямо под нажатой
 * карточкой (остальные съезжают вниз); на компьютере одной широкой панелью под рядом карточек.
 * Раскрыта одна, повторное нажатие закрывает, при нажатии на другую открывается она. Из расшифровки
 * можно перейти к карточкам юрлиц. Живые значения идут из LiveModel.
 */
export function GroupSummary({ moment, input, live, stat, lines, year, getAt }: Props) {
  const [open, setOpen] = useState<CardId | null>(null);
  const wide = useMediaQuery('(min-width: 1024px)');
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

  /** Содержимое расшифровки: общее для панели под рядом и для раскрытия по месту */
  const renderDetail = (id: CardId, inCell: boolean) => {
    const d = detail[id];
    return (
      <div className={inCell ? 'sum-detail acc-body' : 'sum-detail'}>
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
        <CalcActions
          tone="dark"
          focus={id === 'revenue' ? 'revenue' : 'tax'}
          label={`Действия с расчётом: ${d.title}`}
          getTarget={() => ({ queries: bannerQueries(id, year), at: getAt() })}
        />
        <button type="button" className="sum-more" onClick={scrollToEntities}>
          К карточкам юрлиц
        </button>
      </div>
    );
  };

  /** Карточка; на телефоне и планшете вместе с расшифровкой в одной ячейке списка */
  const item = ({ id, label, value, sub }: { id: CardId; label: string; value: string; sub: string }) => {
    const isOpen = open === id;
    return (
      <div key={id} className={`sum-item ${!wide && isOpen ? 'open' : ''}`}>
        <button
          type="button"
          id={`sum-btn-${id}`}
          className={`sum-card ${isOpen ? 'open' : ''}`}
          aria-expanded={isOpen}
          aria-controls={wide ? 'sum-panel' : `sum-detail-${id}`}
          onClick={() => toggle(id)}
        >
          <span className="sum-label">{label}</span>
          <strong className="sum-value">{value}</strong>
          <span className="sum-sub">{sub}</span>
          <SourceLine data={lines[id]} tone="dark" inline />
          <svg className="sum-chev" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        {wide ? null : (
          <div
            id={`sum-detail-${id}`}
            className="acc"
            data-open={isOpen}
            role="region"
            aria-labelledby={`sum-btn-${id}`}
          >
            <div className="acc-in" inert={!isOpen}>
              {renderDetail(id, true)}
            </div>
          </div>
        )}
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

      {wide ? <SumPanel openId={open} render={(id) => renderDetail(id, false)} /> : null}
    </section>
  );
}
