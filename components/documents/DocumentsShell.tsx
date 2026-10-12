'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DocumentsView } from './DocumentsView';

export const DocsShellContext = createContext<{ wide: boolean; toggleWide: () => void }>({
  wide: false,
  toggleWide: () => undefined,
});

const WIDE_KEY = 'pva:doc-wide';

/**
 * Раздел «Документы»: каталог и список (DocumentsView) живут здесь, поэтому не пересоздаются при
 * открытии документа. Открытый документ (страница /documents/[id]) стоит справа от каталога на
 * компьютере от 1100 px (можно развернуть на всю ширину) и занимает весь экран на телефоне и
 * планшете, где каталог на время скрыт. Положение прокрутки каталога запоминается при открытии
 * документа и возвращается при возврате; при первом открытии раздела страница в самом начале.
 */
export function DocumentsShell({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  const open = segment !== null;
  const [wide, setWide] = useState(false);

  // «на всю ширину»: личная настройка просмотра, хранится в браузере и без неё всё работает
  useEffect(() => {
    try {
      setWide(window.localStorage.getItem(WIDE_KEY) === '1');
    } catch {
      // хранилище недоступно: рядом с каталогом
    }
  }, []);
  const toggleWide = useCallback(() => {
    setWide((w) => {
      try {
        window.localStorage.setItem(WIDE_KEY, w ? '0' : '1');
      } catch {
        // не сохранилось: действует до перезагрузки
      }
      return !w;
    });
  }, []);

  // Прокрутка: пока открыт каталог, помним, где страница; при открытии документа это место
  // откладывается, при возврате возвращается
  const lastY = useRef(0);
  const saved = useRef(0);
  const openRef = useRef(open);
  const wasOpen = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const on = () => {
      if (!openRef.current) lastY.current = window.scrollY;
    };
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      saved.current = lastY.current;
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (!open && wasOpen.current) {
      const y = saved.current;
      window.scrollTo({ top: y, behavior: 'instant' });
      wasOpen.current = open;
      // Страница после перехода может ещё раз сдвинуться (высота каталога возвращается, фокус):
      // место ставится несколько раз за полсекунды, пока человек сам не прокрутил
      let mine = true;
      const stop = () => {
        mine = false;
      };
      const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
      for (const ev of events) window.addEventListener(ev, stop, { once: true, passive: true });
      const timers = [30, 90, 200, 400].map((ms) =>
        window.setTimeout(() => {
          if (mine && Math.abs(window.scrollY - y) > 1) window.scrollTo({ top: y, behavior: 'instant' });
        }, ms),
      );
      return () => {
        for (const t of timers) window.clearTimeout(t);
        for (const ev of events) window.removeEventListener(ev, stop);
      };
    }
    wasOpen.current = open;
    return undefined;
  }, [open]);

  // первое открытие раздела: страница в самом начале, заголовок с отступом от шапки
  useLayoutEffect(() => {
    if (!open) window.scrollTo({ top: 0, behavior: 'instant' });
    // только при монтировании раздела
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DocsShellContext.Provider value={{ wide, toggleWide }}>
      <div className={`docs-shell${open ? ' has-doc' : ''}${open && wide ? ' wide' : ''}`} data-testid="docs-shell">
        <div className="docs-rail">
          <DocumentsView activeId={segment} compact={open} />
        </div>
        {open ? <div className="docs-pane">{children}</div> : null}
      </div>
    </DocsShellContext.Provider>
  );
}
