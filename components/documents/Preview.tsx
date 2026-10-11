'use client';

import { Fragment } from 'react';
import type { RenderBlock, Seg, TableCell } from '@/lib/documents/render';
import type { CommentInfo } from '@/lib/documents/types';
import { SOURCE_LABEL } from '@/lib/documents/types';
import { CalcActions } from '@/components/provenance/CalcActions';
import type { TargetBody } from '@/components/provenance/client';
import { SOURCE_CLASS } from './api';

/**
 * Предпросмотр документа. Заполненное подсвечено по источнику: реквизиты юрлица, расчёт, введено
 * вручную; пропущенное выделено пунктиром и подписью в скобках. Цвет не единственный признак:
 * у каждого источника свой вид линии, подписи и условные обозначения над документом. У каждой
 * суммы из расчёта значок «Показать расчёт» (панель из раздела действий над расчётом).
 */
export function Preview({
  blocks,
  documentId,
  version,
  comments,
  sources,
}: {
  blocks: RenderBlock[];
  documentId: string;
  version: number;
  comments: CommentInfo[];
  sources: Record<string, string>;
}) {
  const target = (): TargetBody => ({ document: documentId, version });
  const open = (key: string) => comments.filter((c) => c.fieldKey === key && !c.resolved).length;

  const field = (s: Extract<Seg, { t: 'field' }>, i: number) => {
    const missing = s.state === 'missing';
    const cls = missing ? 'df df-missing' : `df ${SOURCE_CLASS[s.source]}`;
    const note = missing ? 'не заполнено' : (sources[s.key] ?? SOURCE_LABEL[s.source]);
    const n = open(s.key);
    return (
      <Fragment key={`${s.key}-${i}`}>
        <span
          id={`f-${s.key}`}
          className={`${cls}${n > 0 ? ' df-commented' : ''}`}
          data-field={s.key}
          data-state={s.state}
          data-source={s.source}
          data-value={s.value ?? ''}
          tabIndex={0}
          title={`${s.label}: ${note}`}
        >
          {s.text}
          <span className="sr-only">
            {' '}
            ({s.label}, {note}
            {n > 0 ? `, комментариев: ${n}` : ''})
          </span>
        </span>
        {s.calcIndex !== null && !missing ? (
          <CalcActions
            variant="icon"
            tab={s.calcIndex}
            label={`Показать расчёт: ${s.label}`}
            getTarget={target}
            hide={[]}
          />
        ) : null}
        {n > 0 ? (
          <span className="df-badge" aria-hidden="true">
            {n}
          </span>
        ) : null}
      </Fragment>
    );
  };

  const segs = (list: Seg[]) => list.map((s, i) => (s.t === 'text' ? <Fragment key={i}>{s.text}</Fragment> : field(s, i)));

  const cell = (c: TableCell, j: number, row: number, table: string) => (
    <td key={j} className={c.money ? 'n' : undefined}>
      {c.text}
      {c.money ? (
        <CalcActions
          variant="icon"
          tab={0}
          label={`Показать расчёт: ${table}, строка ${row + 1}`}
          getTarget={target}
        />
      ) : null}
    </td>
  );

  const out: React.ReactNode[] = [];
  let list: RenderBlock[] = [];
  const flush = (key: string) => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul-${key}`} className="doc-ul">
        {list.map((b) => (b.kind === 'table' ? null : <li key={b.id} id={b.id}>{segs(b.segs)}</li>))}
      </ul>,
    );
    list = [];
  };

  for (const b of blocks) {
    if (b.kind === 'li') {
      list.push(b);
      continue;
    }
    flush(b.id);
    if (b.kind === 'table') {
      out.push(
        <div key={b.id} id={b.id} className="doc-table-wrap">
          <table className="doc-table">
            <caption className="sr-only">
              {b.table === 'months' ? 'Расчёт по месяцам' : 'Расчёт по юрлицам'}
            </caption>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={h} scope="col" className={i >= 2 ? 'n' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => cell(c, ci, ri, b.table === 'months' ? 'по месяцам' : 'по юрлицам'))}</tr>
              ))}
              {b.rows.length === 0 ? (
                <tr>
                  <td colSpan={b.head.length}>Нет данных расчёта</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>,
      );
    } else if (b.kind === 'h1') {
      out.push(
        <h2 key={b.id} id={b.id} className="doc-h1">
          {segs(b.segs)}
        </h2>,
      );
    } else if (b.kind === 'h2') {
      out.push(
        <h3 key={b.id} id={b.id} className="doc-h2">
          {segs(b.segs)}
        </h3>,
      );
    } else {
      out.push(
        <p key={b.id} id={b.id} className="doc-p">
          {segs(b.segs)}
        </p>,
      );
    }
  }
  flush('end');

  return <>{out}</>;
}

/** Условные обозначения: вид подсветки и подпись, цвет не единственный признак. */
export function Legend() {
  return (
    <ul className="doc-legend" aria-label="Условные обозначения">
      <li>
        <span className="df df-entity">Реквизиты</span> реквизиты юрлица
      </li>
      <li>
        <span className="df df-calc">Расчёт</span> сумма и ставка из расчёта
      </li>
      <li>
        <span className="df df-user">Вручную</span> введено вручную
      </li>
      <li>
        <span className="df df-missing">[Пропущено]</span> не заполнено
      </li>
    </ul>
  );
}
