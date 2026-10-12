import type { ChatTurn, Table } from '@/lib/agent/types';
import { CalcActions } from '@/components/provenance/CalcActions';
import { SourceLine } from '@/components/provenance/SourceLine';
import { MakeDocument } from '@/components/documents/MakeDocument';
import { QuickReplies } from './QuickReplies';
import { Understood } from './Understood';

function TableView({ table }: { table: Table }) {
  const best = new Set((table.best ?? []).map(([r, c]) => `${r}:${c}`));
  const last = table.rows.length - 1;
  return (
    <div className="tscroll">
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
    </div>
  );
}

/**
 * Сообщение чата. Текст выводится как текст, разметки нет, подставить HTML нельзя.
 * Над ответом по расчёту карточка «Понял так», под ним подпись «Цифры из калькулятора» и
 * раскрывающийся блок «Как посчитано», ниже кнопки быстрых ответов (уточнение, сужение до юрлица).
 * onPick отправляет текст кнопки вместе с номером этого ответа.
 */
export function Message({
  turn,
  onPick,
  disabled,
}: {
  turn: ChatTurn;
  onPick?: (text: string, baseId: number) => void;
  disabled?: boolean;
}) {
  if (turn.role === 'user') return <div className="msg me">{turn.text}</div>;

  const paragraphs = turn.text.split(/\n{2,}/).filter(Boolean);
  const pick = (text: string) => onPick?.(text, turn.id);
  return (
    <div className="msg">
      {turn.understood ? (
        <Understood card={turn.understood} change={turn.change} onPick={pick} disabled={disabled || !onPick} />
      ) : null}
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {turn.tables.map((t, i) => (
        <TableView key={i} table={t} />
      ))}
      {/* подпись «Цифры из калькулятора» только там, где строки происхождения нет: иначе она повторяет её */}
      {turn.fromCalc && !turn.provenance ? <span className="src">Цифры из калькулятора</span> : null}
      {turn.provenance ? <SourceLine data={turn.provenance.line} /> : null}
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
      {turn.provenance ? (
        <>
          <CalcActions label="Действия с расчётом" getTarget={() => ({ message: turn.id })} />
          <MakeDocument hint={turn.provenance.doc ?? null} />
        </>
      ) : null}
      {turn.quick.length > 0 ? (
        <QuickReplies
          items={turn.quick}
          label="Быстрые ответы"
          tour="quick"
          showGroupLabels={new Set(turn.quick.map((q) => q.group)).size > 1}
          disabled={disabled || !onPick}
          onPick={pick}
        />
      ) : null}
    </div>
  );
}
