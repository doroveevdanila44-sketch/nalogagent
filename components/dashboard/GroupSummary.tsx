'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '@/lib/client/media';
import { entityColor } from '@/lib/theme';
import {
  ZERO,
  dateRu,
  dateRuYear,
  dec,
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
import { sourceLineText, type SourceLineData } from '@/lib/provenance/line';
import { bannerQueries, type DashboardProvenance } from '@/lib/provenance/dashboard';
import { factPlusRest, groupCaption, groupMetrics, type GroupMetric, type GroupMetricId } from './group-metrics';

type CardId = GroupMetricId;

interface Props {
  moment: Moment;
  input: DashboardInput;
  live: LiveModel;
  stat: StaticModel;
  /** Строки происхождения под баннерами (из результатов calcTax) */
  lines: Record<GroupMetricId, SourceLineData>;
  /** Месяцы факт и прогноз для баннеров «НДС за год» и «Налог на прибыль за год» (calcTax за год) */
  breakdown: DashboardProvenance['breakdown'];
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
 * Строка происхождения: когда у всех четырёх карточек она одинаковая, она стоит один раз под
 * заголовком группы; если строки различаются (основа данных разная), у каждой карточки своя.
 *
 * Раскрытие: на телефоне и планшете расшифровка по юрлицам раскрывается по месту, прямо под нажатой
 * карточкой (остальные съезжают вниз); на компьютере одной широкой панелью под рядом карточек.
 * Раскрыта одна, повторное нажатие закрывает, при нажатии на другую открывается она. Из расшифровки
 * можно перейти к карточкам юрлиц. Живые значения идут из LiveModel.
 */
export function GroupSummary({ moment, input, live, stat, lines, breakdown, year, getAt }: Props) {
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

  const metrics = groupMetrics(live, stat, entities, year);
  const texts = metrics.map((m) => sourceLineText(lines[m.id]));
  const sharedLine = texts.every((t) => t === texts[0]);

  type Row = { id: string; name: string; color: string; tag: string; value: string; note?: string };
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
      title: `НДС за ${year} год: по юрлицам`,
      rows: entities.map((e) => {
        const s = stat.perEntity[e.id]!;
        const payer = e.status === 'payer';
        return {
          id: e.id,
          name: e.name,
          color: entityColor(e),
          tag: payer ? (e.taxRegime === 'osno' ? '22% с вычетами' : `ставка ${s.selected}%`) : 'освобождено',
          value: mln(s.forecast[s.selected]!, 2),
          note: payer ? factPlusRest(live.perEntity[e.id]!.accrued[s.selected] ?? ZERO, s.forecast[s.selected]!) : undefined,
        };
      }),
    },
    profit: {
      title: `Налог на прибыль и УСН за ${year} год: по юрлицам`,
      rows: entities.map((e) => {
        const t = stat.perEntity[e.id]!.incomeTax;
        return {
          id: e.id,
          name: e.name,
          color: entityColor(e),
          tag: `${t.label}, ${t.ratePct.toString()}%`,
          value: mln(t.forecast, 2),
          note: factPlusRest(live.perEntity[e.id]!.incomeTaxAccrued, t.forecast),
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
    '.';

  const STATUS_WORD = { fact: 'факт', partial: 'идёт', forecast: 'прогноз' } as const;

  /** Содержимое расшифровки: общее для панели под рядом и для раскрытия по месту */
  const renderDetail = (id: CardId, inCell: boolean) => {
    const d = detail[id];
    const months = id === 'vatForecast' || id === 'profit' ? breakdown[id].months : null;
    // на бежевом и мятном баннере расшифровка в его цветах, кнопки светлого вида
    const light = id === 'vatForecast' || id === 'profit';
    return (
      <div className={inCell ? 'sum-detail acc-body' : 'sum-detail'} data-card={id}>
        <h3>{d.title}</h3>
        <ul className="sum-rows">
          {d.rows.map((r) => (
            <li key={r.id}>
              <span className="sum-row-name">
                <i style={{ background: r.color }} />
                <span>
                  {r.name}
                  <small>{r.tag}</small>
                  {r.note ? <small data-testid="row-note">{r.note}</small> : null}
                </span>
              </span>
              <b>{r.value}</b>
            </li>
          ))}
        </ul>
        {months ? (
          <>
            <h4>По месяцам{id === 'profit' ? ': налог на прибыль и УСН' : ''}</h4>
            <ul className="bd-months" data-testid={`months-${id}`}>
              {months.map((m) => (
                <li key={m.label} data-status={m.status}>
                  <span className="bd-name">{m.short}</span>
                  <b>{m.amount === null ? 'нет данных' : mln(dec(m.amount), 2)}</b>
                  <span className="bd-pill">{STATUS_WORD[m.status]}</span>
                  {m.extra !== null ? <small>УСН {mln(dec(m.extra), 2)}</small> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {id === 'profit' && <p className="sum-note">{profitNote}</p>}
        <CalcActions
          tone={light ? 'light' : 'dark'}
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
  const item = ({ id, label, tag, value, sub }: GroupMetric) => {
    const isOpen = open === id;
    return (
      <div key={id} className={`sum-item ${!wide && isOpen ? 'open' : ''}`} data-card={id}>
        <button
          type="button"
          id={`sum-btn-${id}`}
          data-card={id}
          className={`sum-card ${isOpen ? 'open' : ''}`}
          aria-expanded={isOpen}
          aria-controls={wide ? 'sum-panel' : `sum-detail-${id}`}
          onClick={() => toggle(id)}
        >
          <span className="sum-label">
            {label}
            {tag ? <span className="sum-tag">{tag}</span> : null}
          </span>
          <strong className="sum-value">{value}</strong>
          {sub.map((line) => (
            <span key={line} className="sum-sub">
              {line}
            </span>
          ))}
          {sharedLine ? null : <SourceLine data={lines[id]} tone="dark" inline />}
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

      {sharedLine ? <SourceLine data={lines[metrics[0]!.id]} /> : null}

      <div className="sum-cards">{metrics.map((m) => item(m))}</div>

      {wide ? <SumPanel openId={open} render={(id) => renderDetail(id, false)} /> : null}
    </section>
  );
}
