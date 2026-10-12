'use client';

import { useCallback, useState } from 'react';
import type { Warning } from '@/lib/calc';

const keyOf = (w: Warning) => `${w.kind}-${w.entityId ?? 'group'}`;

/**
 * Список предупреждений. В свёрнутом виде: заголовок, метка («Срочно», «Внимание», «К сведению»)
 * и стрелка. Пояснение раскрывается по нажатию на строку тем же способом и той же анимацией, что
 * карточки группы (grid-template-rows 0fr к 1fr, 450 мс). Открыть можно несколько сразу.
 * Порядок задан расчётом (lib/calc/warnings.ts): «Срочно» вверху.
 */
export function Warnings({ warnings, counter }: { warnings: Warning[]; counter: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((key: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <>
      <div className="sec-h" data-tour="warnings-head">
        <h2 id="h-warn">Предупреждения</h2>
        <p>{counter}</p>
      </div>
      <ul className="warns">
        {warnings.map((w, i) => {
          const key = keyOf(w);
          const isOpen = open.has(key);
          const id = `warn-${i}`;
          return (
            <li className={`warn ${isOpen ? 'open' : ''}`} key={key} data-tour={i === 0 ? 'warning-first' : undefined}>
              <button
                type="button"
                id={`${id}-btn`}
                className="warn-head"
                aria-expanded={isOpen}
                aria-controls={`${id}-detail`}
                onClick={() => toggle(key)}
              >
                <b className="warn-title">{w.title}</b>
                <span className={`pill ${w.level}`}>{w.tag}</span>
                <svg className="warn-chev" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 10 5 5 5-5" />
                </svg>
              </button>
              <div
                id={`${id}-detail`}
                className="acc"
                data-open={isOpen}
                role="region"
                aria-labelledby={`${id}-btn`}
              >
                <div className="acc-in" inert={!isOpen}>
                  <p className="warn-text acc-body">{w.text}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
