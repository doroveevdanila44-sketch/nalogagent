'use client';

import { useId, useState } from 'react';
import { unfilledText } from '@/lib/documents/fill';

/**
 * Одна строка под карточкой файла: «Не заполнено: 7 полей» со стрелкой. По нажатию раскрывается
 * перечень полей обычным текстом, без плашек и отдельной раскраски (в подписях полей бывают запятые,
 * поэтому перечень построчный, а не через запятую). Кнопка «Дозаполнить» стоит рядом и есть только
 * тогда, когда документ можно править.
 */
export function Unfilled({
  labels,
  onFill,
  describes,
}: {
  labels: string[];
  /** Есть только у документа, который можно править */
  onFill?: () => void;
  /** id строки, на которую ссылается отключённая «Отправить» */
  describes: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (labels.length === 0) return null;
  return (
    <div className="unfilled" data-testid="unfilled">
      <div className="unfilled-row">
        <button
          type="button"
          id={describes}
          className="line-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <span data-testid="missing-count">{unfilledText(labels.length)}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        {onFill ? (
          <button type="button" className="act" data-action="complete" onClick={onFill}>
            Дозаполнить
          </button>
        ) : null}
      </div>
      {open ? (
        <ul id={listId} className="unfilled-list" data-testid="missing-list">
          {labels.map((label, i) => (
            <li key={`${i}-${label}`}>{label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
