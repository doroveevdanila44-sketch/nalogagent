'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { TOUR_STEPS, type TourStep } from './steps';

/**
 * Обучение: шесть шагов поверх приложения. Затемнение с вырезом вокруг нужного элемента (вырез
 * плавно переезжает с шага на шаг), карточка с заголовком, строками, счётчиком «2 из 6» и кнопками
 * «Назад», «Дальше», «Пропустить»; на последнем шаге «Готово».
 *
 * Закрывается Escape, кнопкой «Пропустить», нажатием на затемнение и жестом (смахнуть карточку
 * вниз). Управляется с клавиатуры: Tab и Shift+Tab ходят по кнопкам карточки, стрелки влево и
 * вправо листают шаги, фокус не выходит из карточки. Страница под обучением недоступна для
 * нажатий и фокуса (inert). Движение подчиняется prefers-reduced-motion через общие правила CSS.
 *
 * Что считается «пройдено» и где это хранится решает вызывающий (AppShell: таблица user_prefs).
 */

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Зазор вокруг подсвеченного элемента, зазор до карточки, отступ карточки от края окна, порог жеста */
const PAD = 6;
const GAP = 12;
const MARGIN = 12;
const SWIPE_PX = 56;

/** Что делает страница под обучением недоступной: шапка, содержимое, панель вкладок. */
const BACKGROUND = ['header.top', '.app-body', 'nav.tabs'];

function findTarget(step: TourStep): HTMLElement | null {
  for (const selector of step.targets) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.getClientRects().length > 0 && !el.closest('[hidden]')) return el;
    }
  }
  return null;
}

/**
 * Показывает элемент в окне. Закреплённые элементы (шапка, панель вкладок) не двигаются. Высокий
 * элемент встаёт верхом под шапку; обычный, если он не виден целиком, встаёт выше центра окна:
 * ниже остаётся место для карточки.
 */
function reveal(el: HTMLElement): void {
  if (el.closest('nav.tabs, header.top')) return;
  const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const top = header + MARGIN;
  const tall = r.height > vh * 0.55;
  const visible = r.top >= top && r.bottom <= vh - MARGIN;
  if (visible && !tall) return;
  const wanted = tall ? top : Math.max(top, vh * 0.4 - r.height / 2);
  window.scrollBy({ top: r.top - wanted, behavior: 'instant' });
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return (
    a !== null &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Место карточки: справа от боковой панели, под элементом, над ним или у края окна. top0: верхняя
 * граница, выше которой карточка не поднимается (шапка остаётся видимой).
 */
function placeCard(
  target: Rect | null,
  w: number,
  h: number,
  vw: number,
  vh: number,
  top0: number,
): { top: number; left: number } {
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
  const clampY = (y: number) => Math.min(Math.max(y, top0), Math.max(top0, vh - h - MARGIN));
  if (!target) return { top: clampY((vh - h) / 2), left: clampX((vw - w) / 2) };

  const cx = target.left + target.width / 2;
  const bottom = target.top + target.height;
  // боковая панель компьютера: узкий элемент у левого края, карточка рядом справа
  if (vw >= 760 && target.left < 200 && target.width < 200 && target.left + target.width + GAP + w <= vw - MARGIN) {
    return { top: clampY(target.top + target.height / 2 - h / 2), left: target.left + target.width + GAP };
  }
  if (bottom + GAP + h <= vh - MARGIN) return { top: bottom + GAP, left: clampX(cx - w / 2) };
  if (target.top - GAP - h >= top0) return { top: target.top - GAP - h, left: clampX(cx - w / 2) };
  // рядом не помещается: у того края окна, где свободнее
  const roomBelow = vh - bottom;
  return { top: roomBelow >= target.top ? vh - h - MARGIN : top0, left: clampX(cx - w / 2) };
}

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <TourRun onClose={onClose} /> : null;
}

function TourRun({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const startPath = useRef(pathname);
  const pathNow = useRef(pathname);
  pathNow.current = pathname;

  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [placed, setPlaced] = useState(false);

  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;
  const cardWidth = view.w < 760 ? view.w - MARGIN * 2 : 360;

  // закрытие возвращает на страницу, с которой обучение началось
  const finish = useCallback(() => {
    if (pathNow.current !== startPath.current) router.push(startPath.current);
    onClose();
  }, [onClose, router]);
  const next = useCallback(() => {
    if (last) finish();
    else setIndex((i) => Math.min(i + 1, TOUR_STEPS.length - 1));
  }, [finish, last]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  const latest = useRef({ finish, next, back });
  latest.current = { finish, next, back };

  // страница шага: переход, если шаг показан на другой странице
  useEffect(() => {
    if (step.path && pathname !== step.path) router.push(step.path);
  }, [step.path, pathname, router]);

  // размер окна
  useEffect(() => {
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // положение элемента шага: ищем, пока страница загружается, и следим за ним (прокрутка, перестройка)
  useEffect(() => {
    let alive = true;
    let raf = 0;
    let el: HTMLElement | null = null;
    const tick = () => {
      if (!alive) return;
      if (!el || !el.isConnected || el.getClientRects().length === 0) {
        el = findTarget(step);
        if (el) reveal(el);
      }
      if (el) {
        const r = el.getBoundingClientRect();
        const next: Rect = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
        setRect((cur) => (sameRect(cur, next) ? cur : next));
      } else {
        setRect((cur) => (cur === null ? cur : null));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [step]);

  // карточка: место по размеру, после первого расчёта между шагами она плавно переезжает
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
    setPos(placeCard(rect, card.offsetWidth, card.offsetHeight, view.w, view.h, Math.max(MARGIN, header + MARGIN / 2)));
  }, [rect, index, view]);
  useEffect(() => {
    if (pos) setPlaced(true);
  }, [pos]);

  // фокус на основную кнопку шага: Enter идёт дальше. Пока карточка не поставлена на место, она
  // скрыта и фокус принять не может, поэтому ждём первого расчёта положения.
  const visible = pos !== null;
  useEffect(() => {
    if (!visible) return;
    cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true });
  }, [index, visible]);

  // страница под обучением недоступна: ни нажатий, ни фокуса, ни чтения с экрана
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const marked: HTMLElement[] = [];
    for (const sel of BACKGROUND) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (!el.hasAttribute('inert')) {
          el.setAttribute('inert', '');
          marked.push(el);
        }
      }
    }
    return () => {
      for (const el of marked) el.removeAttribute('inert');
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // клавиатура: Escape закрывает, стрелки листают, Tab ходит по кнопкам карточки
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        latest.current.finish();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        latest.current.next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        latest.current.back();
      } else if (e.key === 'Tab' && card) {
        const items = [...card.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const lastItem = items[items.length - 1]!;
        const active = document.activeElement;
        if (!card.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && active === lastItem) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // перехват раньше остальных: Escape не должен закрыть меню или окно под обучением
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // фокус не уходит из карточки (клик мимо, программный фокус)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const card = cardRef.current;
      if (card && e.target instanceof Node && !card.contains(e.target)) {
        card.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // жест: карточку смахивают вниз
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const card = cardRef.current;
    if (!d || d.id !== e.pointerId || !card) return;
    const dy = e.clientY - d.y;
    const dx = Math.abs(e.clientX - d.x);
    if (dy > 0 && dx < dy) {
      card.style.transform = `translateY(${Math.min(dy, 160)}px)`;
      card.style.opacity = String(Math.max(0.35, 1 - dy / 220));
    }
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const card = cardRef.current;
    if (!d || d.id !== e.pointerId || !card) return;
    const dy = e.clientY - d.y;
    const dx = Math.abs(e.clientX - d.x);
    card.style.transform = '';
    card.style.opacity = '';
    if (e.type === 'pointerup' && dy >= SWIPE_PX && dx < dy) latest.current.finish();
  };

  // нажатие на затемнение закрывает; нажатие внутри выреза ничего не делает
  const onBlockClick = (e: React.MouseEvent) => {
    const inside =
      rect !== null &&
      e.clientX >= rect.left &&
      e.clientX <= rect.left + rect.width &&
      e.clientY >= rect.top &&
      e.clientY <= rect.top + rect.height;
    if (!inside) finish();
  };

  const hole = rect ?? { top: view.h / 2, left: view.w / 2, width: 0, height: 0 };

  return (
    <div className="tour" data-testid="tour" data-step={step.id} data-index={index}>
      <div className="tour-block" aria-hidden="true" data-testid="tour-backdrop" onClick={onBlockClick} />
      <div
        className={`tour-hole${rect ? '' : ' empty'}`}
        aria-hidden="true"
        data-testid="tour-hole"
        style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
      />
      <div
        ref={cardRef}
        className={`tour-card${placed ? ' placed' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="tour-card"
        style={{
          width: cardWidth,
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          visibility: pos ? 'visible' : 'hidden',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <p className="tour-count" data-testid="tour-count">
          {index + 1} из {TOUR_STEPS.length}
        </p>
        <div aria-live="polite">
          <h2 id={titleId} className="tour-title">
            {step.title}
          </h2>
          <div id={bodyId} className="tour-body">
            {step.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
        <div className="tour-acts">
          <button type="button" className="tour-skip" data-action="tour-skip" onClick={finish}>
            Пропустить
          </button>
          <button type="button" className="act ghost" data-action="tour-back" disabled={index === 0} onClick={back}>
            Назад
          </button>
          <button type="button" className="act primary" data-action="tour-next" data-tour-primary onClick={next}>
            {last ? 'Готово' : 'Дальше'}
          </button>
        </div>
      </div>
    </div>
  );
}
