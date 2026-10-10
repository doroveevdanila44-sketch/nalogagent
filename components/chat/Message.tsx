import type { ChatTurn, Table } from '@/lib/agent/types';

function TableView({ table }: { table: Table }) {
  const best = new Set((table.best ?? []).map(([r, c]) => `${r}:${c}`));
  const last = table.rows.length - 1;
  return (
    <table>
      <thead>
        <tr>
          {table.head.map((h, i) => (
            <th key={h} className={i ? 'n' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => {
              const strong = (table.totalRow && r === last) || best.has(`${r}:${c}`);
              return (
                <td key={c} className={`${c ? 'n' : ''} ${best.has(`${r}:${c}`) ? 'best' : ''}`.trim() || undefined}>
                  {strong && !best.has(`${r}:${c}`) ? <b>{cell}</b> : cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Сообщение чата. Текст выводится как текст, разметки нет, подставить HTML нельзя.
 * Под ответом по расчёту подпись «Цифры из калькулятора» и раскрывающийся блок «Как посчитано».
 */
export function Message({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') return <div className="msg me">{turn.text}</div>;

  const paragraphs = turn.text.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="msg">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {turn.tables.map((t, i) => (
        <TableView key={i} table={t} />
      ))}
      {turn.fromCalc ? <span className="src">Цифры из калькулятора</span> : null}
      {turn.how.length > 0 ? (
        <details>
          <summary>Как посчитано</summary>
          <div>
            {turn.how.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
