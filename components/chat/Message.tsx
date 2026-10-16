import type { ChatTurn, FleetFormSubmit, Table } from '@/lib/agent/types';
import { CalcActions } from '@/components/provenance/CalcActions';
import { SourceLine } from '@/components/provenance/SourceLine';
import { MakeDocument } from '@/components/documents/MakeDocument';
import { FleetFormView } from './FleetFormView';
import { QuickReplies } from './QuickReplies';
import { Understood } from './Understood';

/**
 * Первая колонка с переводом строки в ячейке: название юрлица первой строкой, режим и прочее
 * мелким серым текстом второй. Без перевода строки ячейка как была.
 */
function FirstCell({ cell, strong }: { cell: string; strong: boolean }) {
  const [name, ...rest] = cell.split('\n');
  if (rest.length === 0) return strong ? <b>{cell}</b> : <>{cell}</>;
  return (
    <>
      <span className="t-name">{strong ? <b>{name}</b> : name}</span>
      <small className="t-sub">{rest.join(' ')}</small>
    </>
  );
}

function TableView({ table }: { table: Table }) {
  const best = new Set((table.best ?? []).map(([r, c]) => `${r}:${c}`));
  const last = table.rows.length - 1;
  // колонка названий шире остальных, если в ней есть вторая строка (режим): она не дробится на пять
  const wide = table.rows.some((row) => row[0]?.includes('\n'));
  return (
    <div className="tscroll">
    <table className={[wide ? 'has-sub' : '', table.dense ? 'dense' : ''].filter(Boolean).join(' ') || undefined}>
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
                  {c === 0 ? (
                    <FirstCell cell={cell} strong={strong} />
                  ) : strong && !best.has(`${r}:${c}`) ? (
                    <b>{cell}</b>
                  ) : (
                    cell
                  )}
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

const BULLET = '• ';
const SCENARIO_MARK = 'Сценарий, а не прогноз:';

/**
 * Абзац ответа. Строки с «• » это список (допущения сценария), пометка «Сценарий, а не прогноз:»
 * в начале ответа выделена. Остальное обычный текст.
 */
function Paragraph({ text }: { text: string }) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.some((l) => l.startsWith(BULLET))) {
    const head = lines.filter((l) => !l.startsWith(BULLET)).join(' ');
    const items = lines.filter((l) => l.startsWith(BULLET)).map((l) => l.slice(BULLET.length));
    return (
      <>
        {head ? <p className="msg-head">{head}</p> : null}
        <ul className="msg-list">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </>
    );
  }
  if (text.startsWith(SCENARIO_MARK)) {
    return (
      <p>
        <b className="msg-mark" data-testid="scenario-mark">
          {SCENARIO_MARK}
        </b>
        {text.slice(SCENARIO_MARK.length)}
      </p>
    );
  }
  return <p>{text}</p>;
}

/**
 * Сообщение чата. Текст выводится как текст, разметки нет, подставить HTML нельзя.
 * Над ответом по расчёту карточка «Понял так», под ним подпись «Цифры из калькулятора» и
 * раскрывающийся блок «Как посчитано», ниже кнопки быстрых ответов (уточнение, сужение до юрлица).
 * onPick отправляет текст кнопки вместе с номером этого ответа, onSubmitForm поля карточки
 * «Что если купим N машин». Вопрос с полями (mode «ask») после ответа на него остаётся в ленте
 * только для чтения (`locked`): править значения можно в карточке «Понял так» под ответом.
 */
export function Message({
  turn,
  onPick,
  onSubmitForm,
  disabled,
  locked,
}: {
  turn: ChatTurn;
  onPick?: (text: string, baseId: number) => void;
  onSubmitForm?: (v: FleetFormSubmit, baseId: number) => void;
  disabled?: boolean;
  locked?: boolean;
}) {
  if (turn.role === 'user') return <div className="msg me">{turn.text}</div>;

  const paragraphs = turn.text.split(/\n{2,}/).filter(Boolean);
  const pick = (text: string) => onPick?.(text, turn.id);
  const submitForm = onSubmitForm ? (v: FleetFormSubmit) => onSubmitForm(v, turn.id) : undefined;
  return (
    <div className="msg">
      {turn.understood ? (
        <Understood
          card={turn.understood}
          change={turn.change}
          form={turn.form}
          onPick={pick}
          onSubmitForm={submitForm}
          disabled={disabled || !onPick}
        />
      ) : null}
      {paragraphs.map((p, i) => (
        <Paragraph key={i} text={p} />
      ))}
      {turn.form && turn.form.mode === 'ask' && submitForm ? (
        <FleetFormView form={turn.form} onSubmit={submitForm} disabled={disabled} locked={locked} />
      ) : null}
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
