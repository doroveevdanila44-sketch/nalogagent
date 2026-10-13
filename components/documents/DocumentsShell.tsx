'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { appScroller } from '@/lib/client/scroller';
import { DocumentsView } from './DocumentsView';
import { UNDO_SECONDS } from './ConfirmDelete';

export interface DocsShell {
  wide: boolean;
  toggleWide: () => void;
  /** Короткое уведомление; с undo у него кнопка «Отменить» на UNDO_SECONDS секунд */
  notify: (message: string, undo?: () => Promise<void>) => void;
  /** Растёт, когда список документов нужно перечитать (после «Отменить», удаления, отзыва) */
  refresh: number;
  reload: () => void;
}

export const DocsShellContext = createContext<DocsShell>({
  wide: false,
  toggleWide: () => undefined,
  notify: () => undefined,
  refresh: 0,
  reload: () => undefined,
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
  const [refresh, setRefresh] = useState(0);
  const [note, setNote] = useState<{ key: number; message: string; undo?: () => Promise<void> } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const noteTimer = useRef<number | null>(null);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const dismiss = useCallback(() => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = null;
    setNote(null);
  }, []);
  const notify = useCallback(
    (message: string, undo?: () => Promise<void>) => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
      setUndoing(false);
      setNote({ key: Date.now(), message, undo });
      // с кнопкой «Отменить» уведомление живёт 8 секунд, без неё чуть меньше
      noteTimer.current = window.setTimeout(() => setNote(null), (undo ? UNDO_SECONDS : 4) * 1000);
    },
    [],
  );
  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );

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

  // прокручивается область main, а не окно (lib/client/scroller.ts)
  useEffect(() => {
    const el = appScroller();
    if (!el) return;
    const on = () => {
      if (!openRef.current) lastY.current = el.scrollTop;
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);

  useLayoutEffect(() => {
    const el = appScroller();
    const posNow = () => el?.scrollTop ?? 0;
    const to = (top: number) => el?.scrollTo({ top, behavior: 'instant' });
    if (open && !wasOpen.current) {
      saved.current = lastY.current;
      to(0);
    } else if (!open && wasOpen.current) {
      const y = saved.current;
      to(y);
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
          if (mine && Math.abs(posNow() - y) > 1) to(y);
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
    if (!open) appScroller()?.scrollTo({ top: 0, behavior: 'instant' });
    // только при монтировании раздела
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DocsShellContext.Provider value={{ wide, toggleWide, notify, refresh, reload }}>
      <div className={`docs-shell${open ? ' has-doc' : ''}${open && wide ? ' wide' : ''}`} data-testid="docs-shell">
        <div className="docs-rail">
          <DocumentsView activeId={segment} compact={open} />
        </div>
        {open ? <div className="docs-pane">{children}</div> : null}
      </div>
      {note ? (
        <div className="toast" role="status" data-testid="toast" key={note.key}>
          <span>{note.message}</span>
          {note.undo ? (
            <button
              type="button"
              className="toast-undo"
              data-action="undo"
              disabled={undoing}
              onClick={() => {
                const undo = note.undo!;
                setUndoing(true);
                void undo()
                  .then(() => {
                    reload();
                    dismiss();
                  })
                  .catch(() => {
                    setUndoing(false);
                    notify('Не удалось вернуть. Повторите.');
                  });
              }}
            >
              Отменить
            </button>
          ) : null}
        </div>
      ) : null}
    </DocsShellContext.Provider>
  );
}
