'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeLive, computeStatic, fromPayload, momentFromEpoch, type DashboardInput, type StaticModel } from '@/lib/calc';
import { api } from '@/lib/client/api';
import { askAgent } from '@/lib/client/ask';
import type { DashboardResponse } from '@/lib/provenance/dashboard';
import type { Catalog } from '@/components/documents/api';
import type { DocumentSummary } from '@/lib/documents/types';
import { CHAPTER_TITLE, TOUR_STEPS, stepLines, stepTitle, type TourStep } from './chapters';
import { tourNumbers } from './numbers';

/**
 * Обучение: главы и шаги поверх приложения (chapters.ts). Затемнение с вырезом вокруг нужного
 * элемента (вырез плавно переезжает с шага на шаг), карточка с заголовком, тремя строками «Что
 * это», «Как читать», «Что делать», счётчиком «Шаг 6 из 27» и кнопками «Назад», «Дальше»,
 * «Пропустить»; на последнем шаге «Готово».
 *
 * Числа в строках берутся из расчётного сервиса (тот же вход, что у дашборда), на момент шага.
 * Шагам, которым нужен пример, тур готовит его сам: открывает окно расчёта, задаёт агенту вопрос
 * с прогнозом, находит или создаёт документ. Уходя с шага, он закрывает то, что открыл сам.
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

/** Своя разметка inert: страницу под обучением закрываем мы, в поиске цели она не считается. */
const OWN_INERT = 'data-tour-inert';

/** Вопрос, на котором тур показывает ответ агента: прогноз с допущениями, карточка «Понял так», уточнения. */
const EXAMPLE_QUESTION = 'Какую ставку выбрать на 2027 год';

/** Шаблон примера документа: договор с пропусками, когда у человека ещё нет ни одного документа. */
const EXAMPLE_TEMPLATE = 'contract_rent_no_crew';

/**
 * Элемент можно показать: он на экране, не в скрытой или закрытой панели (свёрнутый блок,
 * свёрнутые подсказки) и имеет размер.
 */
function usable(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  if (el.closest('[hidden]')) return false;
  if (el.closest(`[inert]:not([${OWN_INERT}])`)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findTarget(step: TourStep): HTMLElement | null {
  for (const selector of step.targets) {
    const found = [...document.querySelectorAll<HTMLElement>(selector)].filter(usable);
    if (found.length > 0) return step.pick === 'last' ? found[found.length - 1]! : found[0]!;
  }
  return null;
}

/** Ближайший прокручиваемый предок, кроме страницы: список сообщений чата, область окна. */
function scrollBox(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/**
 * Показывает элемент в окне. Закреплённые элементы (шапка, панель вкладок) не двигаются. Элемент
 * в прокручиваемой области (список чата) ставится к её середине. Высокий элемент встаёт верхом
 * под шапку; обычный, если он не виден целиком, встаёт выше центра окна: ниже остаётся место для
 * карточки.
 */
function reveal(el: HTMLElement): void {
  if (el.closest('nav.tabs, header.top')) return;
  const box = scrollBox(el);
  if (box) {
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top + MARGIN || r.bottom > b.bottom - MARGIN) {
      const tallInBox = r.height > b.height * 0.7;
      box.scrollTop += tallInBox ? r.top - b.top - MARGIN : r.top - b.top - (b.height - r.height) / 2;
    }
    return;
  }
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

/** Ждёт, пока функция вернёт значение; null, если время вышло или шаг сменился. */
function until<T>(fn: () => T | null | undefined | false, alive: () => boolean, ms = 12_000, every = 100): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!alive()) return resolve(null);
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - started > ms) return resolve(null);
      window.setTimeout(tick, every);
    };
    tick();
  });
}

/** Первый подходящий элемент по селектору (не в закрытой панели). */
const visibleBy = (selector: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(selector)].find(usable) ?? null;

/**
 * Шаг «Выбор налога»: переключатель есть только в окне расчёта. Тур раскрывает баннер налога на
 * прибыль и нажимает у него «Показать расчёт» (там две вкладки: «Налог на прибыль» и «Налог по
 * УСН»). Возвращает функцию, которая закрывает окно и баннер.
 */
async function openProfitCalc(alive: () => boolean): Promise<() => void> {
  const card = await until(() => document.querySelector<HTMLElement>('.sum-card[data-tour="banner-profit"]'), alive);
  if (!card) return () => undefined;
  let opened = false;
  if (card.getAttribute('aria-expanded') !== 'true') {
    card.click();
    opened = true;
  }
  const button = await until(() => visibleBy('.sum-detail[data-card="profit"] [data-tour="act-calc"]'), alive);
  if (button) button.click();
  return () => {
    document.querySelector<HTMLElement>('[data-testid="overlay-drawer"] .ov-close')?.click();
    if (opened) {
      const again = document.querySelector<HTMLElement>('.sum-card[data-tour="banner-profit"]');
      if (again?.getAttribute('aria-expanded') === 'true') again.click();
    }
  };
}

/**
 * Шагам про ответ агента нужен ответ с карточкой «Понял так». Если такого в истории нет, тур
 * задаёт вопрос с прогнозом сам, тем же путём, что кнопка «Отправить», и дальше ждёт ответ.
 * Возвращает true, если вопрос задан.
 */
async function askExample(alive: () => boolean): Promise<boolean> {
  const ready = await until(() => document.querySelector('.chat-root[data-ready="true"]'), alive);
  if (!ready || document.querySelector('[data-tour="understood"]')) return false;
  askAgent(EXAMPLE_QUESTION);
  return true;
}

/**
 * Документ для шагов про страницу документа: ближайший черновик с пропусками, иначе любой
 * документ, а если документов нет совсем, пример из шаблона (договор с пропусками).
 */
async function exampleDocument(): Promise<string | null> {
  try {
    const list = await api<{ documents: DocumentSummary[] }>('/api/documents');
    const pick =
      list.documents.find((d) => d.status === 'draft' && d.missing > 0) ??
      list.documents.find((d) => d.missing > 0) ??
      list.documents[0];
    if (pick) return pick.id;
    const catalog = await api<Catalog>('/api/documents/templates');
    const entity = catalog.entities[0];
    if (!entity) return null;
    const made = await api<{ id: string }>('/api/documents', {
      body: { templateKey: EXAMPLE_TEMPLATE, entityId: entity.id, period: null },
    });
    return made.id;
  } catch {
    return null;
  }
}

/** Модель дашборда для чисел обучения: вход считается один раз, живые значения на момент шага. */
interface Model {
  input: DashboardInput;
  stat: StaticModel;
  tz: string;
  offset: number;
  year: number;
}

export function Tour({
  open,
  onClose,
  onMenu,
}: {
  open: boolean;
  onClose: () => void;
  /** Открыть или закрыть меню из трёх точек: на шагах главы «Меню» оно открыто */
  onMenu?: (open: boolean) => void;
}) {
  return open ? <TourRun onClose={onClose} onMenu={onMenu} /> : null;
}

function TourRun({ onClose, onMenu }: { onClose: () => void; onMenu?: (open: boolean) => void }) {
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
  const [model, setModel] = useState<Model | null>(null);
  const [asked, setAsked] = useState(false);
  const askedRef = useRef(false);

  const step = TOUR_STEPS[index]!;
  const stepRef = useRef(step);
  stepRef.current = step;
  const last = index === TOUR_STEPS.length - 1;
  const cardWidth = view.w < 760 ? view.w - MARGIN * 2 : 360;

  // числа из расчётного сервиса: вход один раз, живые значения пересчитываются на каждом шаге
  useEffect(() => {
    let alive = true;
    api<DashboardResponse>('/api/dashboard')
      .then((payload) => {
        if (!alive) return;
        const input = fromPayload(payload);
        const at = momentFromEpoch(payload.serverNow, payload.tz);
        setModel({
          input,
          stat: computeStatic(input, at),
          tz: payload.tz,
          offset: payload.serverNow - Date.now(),
          year: payload.provenance.year,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const numbers = useMemo(() => {
    if (!model) return null;
    const at = momentFromEpoch(Date.now() + model.offset, model.tz);
    return tourNumbers(model.input, model.stat, computeLive(model.input, at, model.stat), model.year);
    // пересчёт на каждом шаге: живая выручка к этому моменту выросла
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, index]);

  const lines = stepLines(step, numbers, { asked });
  const title = stepTitle(step, numbers);

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

  // страница шага: переход, если шаг показан на другой странице; документ находим или создаём
  const docPending = useRef(false);
  useEffect(() => {
    if (!step.path) return;
    if (step.path === 'document') {
      if (/^\/documents\/[^/]+$/.test(pathname) || docPending.current) return;
      docPending.current = true;
      void exampleDocument().then((id) => {
        docPending.current = false;
        // пока искали, человек мог уйти на другой шаг
        if (id && stepRef.current.path === 'document' && !/^\/documents\/[^/]+$/.test(pathNow.current)) {
          router.push(`/documents/${id}`, { scroll: false });
        }
      });
      return;
    }
    if (pathname !== step.path) router.push(step.path);
  }, [step.path, pathname, router]);

  // пример для шага: окно расчёта, ответ агента. Уходя с шага, закрываем то, что открыли
  useEffect(() => {
    const kind = step.prepare;
    if (!kind) return;
    if (step.path && step.path !== 'document' && pathname !== step.path) return;
    let alive = true;
    let undo: (() => void) | null = null;
    void (async () => {
      if (kind === 'calc-profit') {
        const u = await openProfitCalc(() => alive);
        if (alive) undo = u;
        else u();
      } else if (!askedRef.current) {
        const did = await askExample(() => alive);
        if (did) {
          askedRef.current = true;
          setAsked(true);
        }
      }
    })();
    return () => {
      alive = false;
      undo?.();
    };
  }, [step, pathname]);

  // меню из трёх точек: на шагах главы «Меню» оно открыто, при уходе и закрытии тура закрывается
  const onMenuRef = useRef(onMenu);
  onMenuRef.current = onMenu;
  useEffect(() => {
    onMenuRef.current?.(Boolean(step.menu));
  }, [step.menu]);
  useEffect(() => () => onMenuRef.current?.(false), []);

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
      // шаг показан только на своей странице: пока идёт переход, подсвечивать нечего
      const onPage =
        step.path === null ||
        step.path === pathNow.current ||
        (step.path === 'document' && /^\/documents\/[^/]+$/.test(pathNow.current));
      if (!onPage) el = null;
      else if (!el || !el.isConnected || !usable(el)) {
        const found = findTarget(step);
        if (found !== el) {
          el = found;
          if (el) reveal(el);
        }
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
  }, [rect, index, view, numbers, asked]);
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
          el.setAttribute(OWN_INERT, '');
          marked.push(el);
        }
      }
    }
    return () => {
      for (const el of marked) {
        el.removeAttribute('inert');
        el.removeAttribute(OWN_INERT);
      }
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
    <div className="tour" data-testid="tour" data-step={step.id} data-chapter={step.chapter} data-index={index}>
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
        <p className="tour-count">
          <span data-testid="tour-count">
            Шаг {index + 1} из {TOUR_STEPS.length}
          </span>
          <span className="tour-chapter" data-testid="tour-chapter">
            {CHAPTER_TITLE[step.chapter]}
          </span>
        </p>
        <div aria-live="polite">
          <h2 id={titleId} className="tour-title" data-testid="tour-title">
            {title}
          </h2>
          <div id={bodyId} className="tour-body">
            {lines.map((l) => (
              <p key={l.key} data-line={l.key}>
                <b>{l.label}:</b> {l.text}
              </p>
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
