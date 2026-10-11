'use client';

import { useId, useState, type MouseEvent, type PointerEvent } from 'react';
import type { ChangeOptions, Understanding } from '@/lib/agent/types';
import { QuickReplies } from './QuickReplies';

const hold = (e: PointerEvent | MouseEvent) => e.preventDefault();

/**
 * Первая строка ответа: как агент понял вопрос. «Понял так: ООО «Альфа», НДС, февраль 2026 (факт)».
 * Под ней допущения, если они были, и кнопка «Изменить»: по нажатию варианты юрлица, налога
 * и периода. Выбор уходит в чат как короткий ответ и пересчитывает прежний вопрос.
 */
export function Understood({
  card,
  change,
  onPick,
  disabled,
}: {
  card: Understanding;
  change: ChangeOptions | null;
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const items = change ? [...change.entity, ...change.tax, ...change.period] : [];

  return (
    <div className="understood">
      <div className="u-main">
        <p className="u-text">
          <span className="u-label">Понял так:</span> <b>{card.entity}</b>, <b>{card.tax}</b>,{' '}
          <b>{card.period}</b> <span className="u-kind">({card.kindLabel})</span>
        </p>
        {change ? (
          <button
            type="button"
            className="u-edit"
            aria-expanded={open}
            aria-controls={panel}
            onPointerDown={hold}
            onMouseDown={hold}
            onClick={() => setOpen((v) => !v)}
          >
            Изменить
          </button>
        ) : null}
      </div>
      {card.notes.length > 0 ? <p className="u-notes">{card.notes.join('. ')}.</p> : null}
      {change ? (
        <div id={panel} className="u-panel" hidden={!open}>
          <QuickReplies
            items={items}
            label="Варианты уточнения"
            showGroupLabels
            disabled={disabled}
            onPick={(text) => {
              setOpen(false);
              onPick(text);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
