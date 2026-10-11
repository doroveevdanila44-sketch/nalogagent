'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LOCKED_EVENT } from '@/lib/client/api';
import { holdLive } from '@/lib/client/live';

/**
 * Окно поверх страницы для панели расчёта, экрана проверки и передачи специалисту.
 *  drawer  справа на компьютере, нижний лист на телефоне;
 *  screen  экран-чеклист: на телефоне на всю высоту, на компьютере широкая панель справа;
 *  modal   диалог по центру, на телефоне нижний лист.
 * Окно живёт в #overlay-root внутри оболочки приложения: при блокировке на PIN оно скрывается
 * вместе со страницей. Пока окно открыто, живые цифры дашборда стоят (lib/client/live.ts), фокус
 * удерживается внутри окна, Escape закрывает верхнее окно, прокрутка страницы под ним выключена.
 */

const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Overlay({
  label,
  kind,
  onClose,
  children,
}: {
  label: string;
  kind: 'drawer' | 'screen' | 'modal';
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useRef(Symbol('overlay'));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setRoot(document.getElementById('overlay-root') ?? document.body);
  }, []);

  useEffect(() => {
    const me = id.current;
    stack.push(me);
    const release = holdLive();
    const opener = document.activeElement as HTMLElement | null;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    panelRef.current?.focus();

    const top = () => stack[stack.length - 1] === me;
    const onKey = (e: KeyboardEvent) => {
      if (!top()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onLocked = () => closeRef.current();
    document.addEventListener('keydown', onKey);
    window.addEventListener(LOCKED_EVENT, onLocked);

    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(LOCKED_EVENT, onLocked);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) html.style.overflow = prevOverflow;
      release();
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  if (!root) return null;
  return createPortal(
    <div
      className={`ov-backdrop ov-${kind}`}
      onMouseDown={(e) => {
        // событие идёт по дереву React к предкам (в чате корень гасит mousedown на телефоне, и поле
        // комментария не получило бы фокус): до них оно не доходит
        e.stopPropagation();
        if (e.target === e.currentTarget && kind !== 'screen') onClose();
      }}
    >
      <div
        className="ov-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={panelRef}
        data-testid={`overlay-${kind}`}
      >
        {children}
      </div>
    </div>,
    root,
  );
}

/** Шапка окна: заголовок и кнопка закрытия 44 на 44 px. */
export function OverlayHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <header className="ov-head">
      <div className="ov-title">
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      <button type="button" className="ov-close" aria-label="Закрыть" onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </header>
  );
}
