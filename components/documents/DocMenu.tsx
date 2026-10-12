'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  /** Число рядом с подписью (например, комментарии без решения) */
  badge?: number;
  /** Ссылка вместо действия: «Скачать» */
  href?: string;
  download?: boolean;
  onSelect?: () => void;
}

/**
 * Меню «ещё» (три точки) у заголовка документа: раскрывается под кнопкой. Стрелки вверх и вниз
 * ходят по пунктам, Home и End в начало и конец, Escape закрывает и возвращает фокус на кнопку,
 * нажатие вне меню закрывает.
 */
export function DocMenu({ items, dot = false }: { items: MenuItem[]; dot?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const nodes = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      nodes[(i + nodes.length) % nodes.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? nodes.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(nodes.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="doc-more" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        data-action="more"
        data-tour="doc-menu"
        aria-label="Ещё"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5.5" r="1.2" />
          <circle cx="12" cy="12" r="1.2" />
          <circle cx="12" cy="18.5" r="1.2" />
        </svg>
        {dot ? <span className="more-dot" aria-hidden="true" data-testid="more-dot" /> : null}
      </button>
      {open ? (
        <div id={menuId} className="doc-menu" role="menu" aria-label="Действия с документом">
          {items.map((it) => {
            const body = (
              <>
                {it.label}
                {it.badge ? <span className="menu-badge">{it.badge}</span> : null}
              </>
            );
            return it.href ? (
              <a
                key={it.key}
                role="menuitem"
                className="menu-item"
                data-action={it.key}
                href={it.href}
                download={it.download ? '' : undefined}
                onClick={() => setOpen(false)}
              >
                {body}
              </a>
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className="menu-item"
                data-action={it.key}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                {body}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
