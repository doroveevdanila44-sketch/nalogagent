'use client';

import { Fragment, type ReactNode } from 'react';
import { CalcActions } from '@/components/provenance/CalcActions';
import type { TargetBody } from '@/components/provenance/client';
import type { DocumentDetail } from '@/lib/documents/detail';
import { gridRows, type RenderBlock, type Seg, type TableCell } from '@/lib/documents/render';
import { SOURCE_LABEL } from '@/lib/documents/types';

/** Свойства подсказки источника: наведение, фокус, долгое нажатие (DocumentSheet). */
export type TipProps = (text: string) => Record<string, unknown>;

export interface SheetCtx {
  doc: DocumentDetail;
  /** Поле можно ввести или поправить вручную на этой версии */
  editable: (key: string) => boolean;
  onEdit: (key: string) => void;
  tipProps: TipProps;
}

type FieldSeg = Extract<Seg, { t: 'field' }>;

/**
 * Поле в тексте листа. Пропущенное: жёлтое `#FFF3B2` и в скобках «[Номер договора]», по нажатию окно
 * ввода. Заполненное из реквизитов юрлица или расчёта: тонкое подчёркивание и подсказка источника
 * (наведение, фокус, долгое нажатие). Введённое вручную: обычный текст, по нажатию поправить.
 * Рядом с суммой из расчёта значок «Показать расчёт».
 */
function SheetField({ seg, ctx }: { seg: FieldSeg; ctx: SheetCtx }) {
  const { doc } = ctx;
  const missing = seg.state === 'missing';
  const editable = ctx.editable(seg.key);
  const note = missing ? 'не заполнено' : (doc.sources[seg.key] ?? SOURCE_LABEL[seg.source]);
  const common = {
    id: `f-${seg.key}`,
    className: `sf ${missing ? 'sf-missing' : `sf-${seg.source}`}${editable ? ' sf-edit' : ''}`,
    'data-field': seg.key,
    'data-state': seg.state,
    'data-source': seg.source,
    'data-value': seg.value ?? '',
    'data-tour': missing ? 'doc-gap' : undefined,
    ...(missing ? {} : ctx.tipProps(note)),
  };
  const body = (
    <>
      {seg.text}
      <span className="sr-only">
        {' '}
        ({seg.label}, {note})
      </span>
    </>
  );
  const target = (): TargetBody => ({ document: doc.id, version: doc.shownVersion });
  return (
    <>
      {editable ? (
        <button type="button" {...common} onClick={() => ctx.onEdit(seg.key)}>
          {body}
        </button>
      ) : (
        <span {...common} tabIndex={0}>
          {body}
        </span>
      )}
      {seg.calcIndex !== null && !missing ? (
        <CalcActions variant="icon" tab={seg.calcIndex} label={`Показать расчёт: ${seg.label}`} getTarget={target} hide={[]} />
      ) : null}
    </>
  );
}

function Segs({ segs, ctx }: { segs: Seg[]; ctx: SheetCtx }) {
  return (
    <>
      {segs.map((s, i) =>
        s.t === 'text' ? <Fragment key={i}>{s.text}</Fragment> : <SheetField key={`${s.key}-${i}`} seg={s} ctx={ctx} />,
      )}
    </>
  );
}

function TableView({ block, ctx }: { block: Extract<RenderBlock, { kind: 'table' }>; ctx: SheetCtx }) {
  const target = (): TargetBody => ({ document: ctx.doc.id, version: ctx.doc.shownVersion });
  const cell = (c: TableCell, j: number, row: number) => (
    <td key={j} className={c.money ? 'n' : undefined}>
      {c.text}
      {c.money ? (
        <CalcActions
          variant="icon"
          tab={0}
          label={`Показать расчёт: ${block.table === 'months' ? 'по месяцам' : 'по юрлицам'}, строка ${row + 1}`}
          getTarget={target}
        />
      ) : null}
    </td>
  );
  return (
    <div id={block.id} className="sheet-table-wrap">
      <table className="sheet-table">
        <caption className="sr-only">{block.table === 'months' ? 'Расчёт по месяцам' : 'Расчёт по юрлицам'}</caption>
        <thead>
          <tr>
            {block.head.map((h, i) => (
              <th key={h} scope="col" className={i >= 2 ? 'n' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => cell(c, ci, ri))}</tr>
          ))}
          {block.rows.length === 0 ? (
            <tr>
              <td colSpan={block.head.length}>Нет данных расчёта</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** Договор, допсоглашение, отчёт: текст листа, как в Word. */
export function TextSheet({ ctx }: { ctx: SheetCtx }) {
  const out: ReactNode[] = [];
  let list: Exclude<RenderBlock, { kind: 'table' }>[] = [];
  const flush = (key: string) => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul-${key}`} className="sheet-ul">
        {list.map((b) => (
          <li key={b.id} id={b.id}>
            <Segs segs={b.segs} ctx={ctx} />
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const b of ctx.doc.blocks) {
    if (b.kind === 'li') {
      list.push(b);
      continue;
    }
    flush(b.id);
    if (b.kind === 'table') out.push(<TableView key={b.id} block={b} ctx={ctx} />);
    else if (b.kind === 'h1')
      out.push(
        <h2 key={b.id} id={b.id} className="sheet-h1">
          <Segs segs={b.segs} ctx={ctx} />
        </h2>,
      );
    else if (b.kind === 'h2')
      out.push(
        <h3 key={b.id} id={b.id} className="sheet-h2">
          <Segs segs={b.segs} ctx={ctx} />
        </h3>,
      );
    else
      out.push(
        <p key={b.id} id={b.id} className="sheet-p">
          <Segs segs={b.segs} ctx={ctx} />
        </p>,
      );
  }
  flush('end');
  return <div className="sheet-text">{out}</div>;
}

/**
 * Проект декларации и другие таблицы (.xlsx): сетка, как лист Excel. Строка «название: значение»
 * это две ячейки, раздел это строка-заголовок, таблица расчёта идёт целиком.
 */
export function GridSheet({ ctx }: { ctx: SheetCtx }) {
  const rows = gridRows(ctx.doc.blocks);
  return (
    <div className="sheet-grid">
      {ctx.doc.category === 'declaration' ? (
        <p className="grid-mark" data-testid="draft-mark">
          Проект. Не для подачи
        </p>
      ) : null}
      <table className="grid-table">
        <caption className="sr-only">{ctx.doc.title}</caption>
        <tbody>
          {rows.map((r) => {
            if (r.kind === 'table') {
              return (
                <tr key={r.id}>
                  <td colSpan={2} className="grid-inner">
                    <TableView block={{ id: r.id, kind: 'table', table: r.table, head: r.head, rows: r.rows, calcIndex: r.calcIndex }} ctx={ctx} />
                  </td>
                </tr>
              );
            }
            if (r.kind === 'title') {
              return (
                <tr key={r.id} className="grid-title">
                  <th colSpan={2} scope="colgroup">
                    <Segs segs={r.segs} ctx={ctx} />
                  </th>
                </tr>
              );
            }
            if (r.kind === 'section') {
              return (
                <tr key={r.id} className="grid-section">
                  <th colSpan={2} scope="colgroup">
                    <Segs segs={r.segs} ctx={ctx} />
                  </th>
                </tr>
              );
            }
            if (r.kind === 'pair') {
              return (
                <tr key={r.id}>
                  <th scope="row" className="grid-label">
                    {r.label}
                  </th>
                  <td className="grid-value">
                    <Segs segs={r.segs} ctx={ctx} />
                  </td>
                </tr>
              );
            }
            return (
              <tr key={r.id}>
                <td colSpan={2} className="grid-note">
                  <Segs segs={r.segs} ctx={ctx} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
