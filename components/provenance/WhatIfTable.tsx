import {
  diffText,
  entityTable,
  limitLine,
  money,
  summaryTable,
  thresholdLine,
  unifiedLine,
  verdictLine,
  type TableS,
  type WhatIfSnapshot,
} from '@/lib/provenance/whatif';

function Grid({ table, caption }: { table: TableS; caption: string }) {
  const last = table.rows.length - 1;
  return (
    <div className="wi-scroll">
      <table className="wi-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {table.head.map((h, i) => (
              <th key={h} scope="col" className={i ? 'n' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className={table.totalRow && r === last ? 'total' : undefined}>
              {row.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={c} className="n">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * «Сейчас и по сценарию» в панели «Показать расчёт»: сводная таблица, по юрлицам, порог освобождения,
 * доля лимита ставки 5%, признаки единого бизнеса и допущения. Все числа из сохранённого сравнения
 * (WhatIfSnapshot), то есть те же, что в ответе агента и в файле Excel.
 */
export function WhatIfTable({ data }: { data: WhatIfSnapshot }) {
  const summary = summaryTable(data);
  const byEntity = entityTable(data);
  const notes: string[] = [];
  for (const r of data.rows) {
    const line = thresholdLine(r, data.year);
    if (line) notes.push(line);
  }
  const limit = limitLine(data.rows);
  if (limit) notes.push(limit);
  const verdict = verdictLine(data);
  if (verdict) notes.push(verdict);
  const unified = unifiedLine(data);

  return (
    <section className="calc-sec" aria-labelledby="c-whatif" data-testid="calc-whatif">
      <h3 id="c-whatif">Сейчас и по сценарию</h3>
      <p className="calc-note">
        <b>Сценарий, а не прогноз:</b> {data.title}, {data.monthsLabel || `${data.year} год`}. Данные дашборда не
        меняются.
      </p>
      <Grid table={summary} caption="Показатели за год сейчас и по сценарию" />
      {byEntity ? <Grid table={byEntity} caption="Налоги по юрлицам сейчас и по сценарию" /> : null}
      {data.rows.length > 1 ? (
        <details className="calc-steps">
          <summary>
            Выручка по юрлицам
            <span>{data.rows.length} юрлица</span>
          </summary>
          <ul className="kv-list">
            {data.rows.map((r) => (
              <li key={r.entityId} data-entity={r.entityId}>
                <div className="kv-name">
                  <b>{r.name}</b>
                </div>
                <div className="kv-vals">
                  <span>
                    Выручка: <b>{money(r.revenue.base)}</b> → <b>{money(r.revenue.scenario)}</b> ({diffText(r.revenue)})
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {notes.length > 0 ? (
        <ul className="calc-warns">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      {unified ? (
        <p className="calc-flag" data-testid="calc-unified">
          {unified}
        </p>
      ) : null}
      <h4 className="wi-h">Допущения</h4>
      <ul className="calc-warns" data-testid="calc-assumptions">
        {data.assumptions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </section>
  );
}
