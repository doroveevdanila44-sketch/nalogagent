'use client';

import type { MouseEvent, PointerEvent } from 'react';
import type { QuickReply, Slot } from '@/lib/agent/types';

const GROUP_LABEL: Record<Slot, string> = { entity: 'Юрлицо', tax: 'Налог', period: 'Период' };

/**
 * Нажатие не отбирает фокус у поля ввода: экранная клавиатура остаётся открытой, как у
 * подсказок над полем.
 */
const hold = (e: PointerEvent | MouseEvent) => e.preventDefault();

/**
 * Кнопки быстрых ответов. Текст кнопки уходит в чат как сообщение пользователя вместе с номером
 * ответа, к которому относится нажатие: агент продолжает именно тот вопрос.
 */
export function QuickReplies({
  items,
  onPick,
  disabled,
  label,
  showGroupLabels = false,
}: {
  items: QuickReply[];
  onPick: (text: string) => void;
  disabled?: boolean;
  label: string;
  /** Подписи рядов «Юрлицо», «Налог», «Период»: нужны, когда в наборе несколько видов кнопок */
  showGroupLabels?: boolean;
}) {
  // ряды по виду кнопки; без вида одна общая строка
  const rows: { group: Slot | null; list: QuickReply[] }[] = [];
  for (const q of items) {
    const g = q.group ?? null;
    const last = rows[rows.length - 1];
    if (last && last.group === g) last.list.push(q);
    else rows.push({ group: g, list: [q] });
  }
  return (
    <div className="qreplies" role="group" aria-label={label}>
      {rows.map((row, r) => (
        <div className="qrow" key={r}>
          {showGroupLabels && row.group ? <span className="qlabel">{GROUP_LABEL[row.group]}</span> : null}
          <div className="qlist">
            {row.list.map((q) => (
              <button
                key={`${q.group ?? ''}:${q.text}`}
                type="button"
                className="qreply"
                disabled={disabled}
                onPointerDown={hold}
                onMouseDown={hold}
                onClick={() => onPick(q.text)}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
