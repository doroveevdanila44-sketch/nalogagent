'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeLive, computeStatic, fromPayload, momentFromEpoch, type DashboardInput, type StaticModel } from '@/lib/calc';
import { api, UNLOCKED_EVENT } from '@/lib/client/api';
import { askAgent } from '@/lib/client/ask';
import type { DashboardResponse } from '@/lib/provenance/dashboard';
import type { Catalog } from '@/components/documents/api';
import type { DocumentSummary } from '@/lib/documents/types';
import { CHAPTER_TITLE, stepsFor, stepLines, stepTitle, type TourMode, type TourStep } from './chapters';
import { tourNumbers } from './numbers';

/**
 * Обучение: главы и шаги поверх приложения (chapters.ts). Затемнение с вырезом вокруг нужного
 * элемента, карточка с заголовком, тремя строками «Что это», «Как читать», «Что делать», счётчиком
 * «Шаг 3 из 8» и кнопками «Назад», «Дальше», «Пропустить обучение»; на последнем шаге «Готово».
 * Первый показ это восемь шагов, по кнопке меню «Показать подсказки заново» идут все подсказки.
 *
 * Числа в строках берутся из расчётного сервиса (тот же вход, что у дашборда), на момент шага.
 * Шагам, которым нужен пример, тур готовит его сам: открывает окно расчёта, задаёт агенту вопрос
 * с прогнозом, находит или создаёт документ. Уходя с шага, он закрывает то, что открыл сам.
 *
 * Закрывается только кнопкой «Пропустить обучение» (на последнем шаге «Готово»). Нажатие на
 * затемнение и пустое место, свайп, Escape и кнопка «назад» браузера тур не закрывают. На шагах
 * «показ» нажатия вне карточки блокируются, на шагах «попробуйте» (mode: 'try') проходит только
 * нажатие по подсвеченному элементу. С клавиатуры: Tab и Shift+Tab по кнопкам карточки, стрелки
 * влево и вправо листают шаги. Страница под обучением недоступна для нажатий и фокуса (inert).
 *
 * Шаг показывается в таком порядке: переход на страницу, ожидание элемента (MutationObserver, до
 * 3 секунд, у шагов с примером дольше), прокрутка к нему в нужном контейнере, ожидание стабильной
 * позиции (два кадра подряд) и только потом вырез и карточка. Если элемента нет или он не помещается
 * в окно, карточка стоит по центру без затемнения и в консоль пишется предупреждение. Затемнения
 * без карточки не бывает: вырез и затемнение рисуются только вместе с видимой карточкой.
 *
 * Что считается «пройдено» и где это хранится решает вызывающий (AppShell: таблица user_prefs).
 */

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Фаза шага: ищем элемент (ничего не показано), элемент на месте (вырез и карточка), запасной вид (карточка по центру) */
type Phase = 'seek' | 'ready' | 'fallback';

/** Зазор вокруг подсвеченного элемента, зазор до карточки, отступ карточки от края окна */
const PAD = 6;
const GAP = 12;
const MARGIN = 12;

/** Сколько ждать элемент шага: обычный шаг и шаг с примером (ответ агента, окно расчёта) */
const WAIT_MS = 3_000;
const WAIT_PREPARE_MS = 15_000;

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
  // закрытый или закрывающийся раскрывающийся блок: содержимое ещё в раскладке, но его не показывают
  if (el.closest('.acc[data-open="false"]')) return false;
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

/** Страница, на которой показывается шаг (для шага «document» это любая страница документа). */
function onStepPage(step: TourStep, pathname: string): boolean {
  if (step.path === null) return true;
  if (step.path === 'document') return /^\/documents\/[^/]+$/.test(pathname);
  return pathname === step.path;
}

/** Ближайший прокручиваемый предок, кроме страницы: область main, список чата, область окна. */
function scrollBox(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/**
 * Показывает элемент в его прокручиваемой области (main, список чата, область окна): целиком, у
 * середины области; высокий элемент встаёт верхом. Страница сама не прокручивается, шапка и
 * панель вкладок стоят на месте. need: высота карточки с зазором; если карточке негде встать ни
 * над элементом, ни под ним (на телефоне она высотой больше трети окна), элемент поднимается к
 * верху области, и карточка встаёт под ним, не закрывая его.
 */
function reveal(el: HTMLElement, need = 0): void {
  if (el.closest('nav.tabs, header.top')) return;
  const box = scrollBox(el);
  if (!box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
  const top0 = Math.max(MARGIN, header + MARGIN / 2);
  const below = r.bottom + PAD + GAP + need <= vh - MARGIN;
  const above = r.top - PAD - GAP - need >= top0;
  const visible = r.top >= b.top + MARGIN && r.bottom <= b.bottom - MARGIN;
  if (visible && (need === 0 || below || above)) return;
  if (need > 0 && !below && !above) {
    box.scrollTop += r.top - b.top - MARGIN - PAD;
    return;
  }
  const tall = r.height > b.height * 0.7;
  box.scrollTop += tall ? r.top - b.top - MARGIN : r.top - b.top - (b.height - r.height) / 2;
}

/** Область, в пределах которой элемент виден: прокручиваемый контейнер или окно целиком. */
function viewOf(el: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  const box = el.closest<HTMLElement>('.app-main, .chat-scroll, .ov-scroll');
  const w = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  if (!box) return w;
  const r = box.getBoundingClientRect();
  return {
    top: Math.max(w.top, r.top),
    bottom: Math.min(w.bottom, r.bottom),
    left: Math.max(w.left, r.left),
    right: Math.min(w.right, r.right),
  };
}

/** Элемент целиком в области просмотра. */
function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = viewOf(el);
  return r.top >= v.top - 1 && r.bottom <= v.bottom + 1 && r.left >= v.left - 1 && r.right <= v.right + 1;
}

/**
 * Вырез поместится в окно: элемент не выше области и не шире окна. Зазор по ширине не требуется:
 * вырез у края окна обрезается по окну (measure), поэтому нижний лист меню на всю ширину телефона
 * подсвечивается, а не уходит в запасной вид.
 */
function fitsWindow(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = viewOf(el);
  return r.height + PAD * 2 <= v.bottom - v.top && r.width <= window.innerWidth + 0.5;
}

/** Карточке высотой need хватает места под элементом или над ним (не закрывая его). */
function roomFor(el: HTMLElement, need: number): boolean {
  if (need <= 0) return true;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
  const top0 = Math.max(MARGIN, header + MARGIN / 2);
  return r.bottom + PAD + GAP + need <= vh - MARGIN || r.top - PAD - GAP - need >= top0;
}

/** Два кадра подряд с одним и тем же положением: прокрутка и раскрытие блоков закончились. */
function stable(el: HTMLElement, alive: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let prev = '';
    let frames = 0;
    const tick = () => {
      if (!alive() || !el.isConnected) return resolve();
      const r = el.getBoundingClientRect();
      const key = `${r.top.toFixed(1)}|${r.left.toFixed(1)}|${r.width.toFixed(1)}|${r.height.toFixed(1)}`;
      frames += 1;
      if (key === prev || frames > 90) return resolve();
      prev = key;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Подводит элемент к показу: прокрутка в нужном контейнере, ожидание стабильной позиции, проверка,
 * что он в области просмотра. Раскрывающийся или сворачивающийся блок над элементом ещё двигает его
 * (так терялась подсветка на шаге «Кнопки под цифрой»), поэтому цикл повторяется, пока позиция не
 * установится. true: элемент на месте и вырез поместится в окно.
 */
async function settle(el: HTMLElement, alive: () => boolean, need: () => number): Promise<boolean> {
  for (let attempt = 0; attempt < 6 && alive(); attempt += 1) {
    reveal(el, need());
    await stable(el, alive);
    if (!el.isConnected) return false;
    // элемент в окне и рядом есть место для карточки; иначе подводим ещё раз (первая прокрутка
    // ставит его к середине области, а карточке под ним может не хватить высоты на телефоне)
    if (inView(el) && roomFor(el, need())) return fitsWindow(el);
  }
  return el.isConnected && inView(el) && fitsWindow(el);
}

/** Вырез: элемент с зазором, но не за краем окна (панель действий листа стоит вплотную к низу окна). */
function measure(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  const top = Math.max(0, r.top - PAD);
  const left = Math.max(0, r.left - PAD);
  const bottom = Math.min(window.innerHeight, r.bottom + PAD);
  const right = Math.min(window.innerWidth, r.right + PAD);
  return { top, left, width: right - left, height: bottom - top };
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

/**
 * Ждёт элемент шага: проверка при каждом изменении страницы (MutationObserver) и по таймеру как
 * страховка (размеры и данные меняются и без правок DOM). null: время вышло или шаг сменился.
 */
function waitFor<T>(fn: () => T | null, alive: () => boolean, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let poll = 0;
    let timer = 0;
    const mo = new MutationObserver(() => check());
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      mo.disconnect();
      window.clearInterval(poll);
      window.clearTimeout(timer);
      resolve(v);
    };
    function check() {
      if (done) return;
      if (!alive()) return finish(null);
      const v = fn();
      if (v) finish(v);
    }
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'inert', 'style', 'aria-expanded', 'data-open', 'data-ready'],
    });
    poll = window.setInterval(check, 150);
    timer = window.setTimeout(() => finish(null), ms);
    check();
  });
}

/** Первый подходящий элемент по селектору (не в закрытой панели). */
const visibleBy = (selector: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(selector)].find(usable) ?? null;

/**
 * Шаг «Выбор налога»: переключатель есть только в окне расчёта. Тур раскрывает баннер налога на
 * прибыль и нажимает у него «Показать расчёт» (там две вкладки: «Налог на прибыль» и «Налог по
 * УСН»). Возвращает функцию, которая закрывает окно. Баннер сворачивает движок шага при уходе с
 * него (раскрытое на шаге сворачивается, EXPANDABLE): второй раз его здесь трогать нельзя, иначе
 * два переключения подряд оставляли баннер раскрытым, и следующий шаг искал кнопки внутри него.
 */
async function openProfitCalc(alive: () => boolean): Promise<() => void> {
  const card = await until(() => document.querySelector<HTMLElement>('.sum-card[data-tour="banner-profit"]'), alive);
  if (!card) return () => undefined;
  if (card.getAttribute('aria-expanded') !== 'true') card.click();
  const button = await until(() => visibleBy('.sum-detail[data-card="profit"] [data-tour="act-calc"]'), alive);
  if (button) button.click();
  return () => {
    document.querySelector<HTMLElement>('[data-testid="overlay-drawer"] .ov-close')?.click();
  };
}

/**
 * Шагам про ответ агента нужен ответ с тем, что они подсвечивают: карточка «Понял так», кнопки
 * уточнений, «Отправить на проверку». Если такого элемента в истории нет, тур задаёт вопрос с
 * прогнозом сам (в его ответе есть всё перечисленное), тем же путём, что кнопка «Отправить», и
 * дальше ждёт ответ. Возвращает true, если вопрос задан.
 */
async function askExample(alive: () => boolean, need: string): Promise<boolean> {
  const ready = await until(() => document.querySelector('.chat-root[data-ready="true"]'), alive);
  if (!ready || document.querySelector(need)) return false;
  askAgent(EXAMPLE_QUESTION);
  return true;
}

/** Селектор того, что шаг с примером подсвечивает в ответе: последняя из его целей. */
const needOf = (step: TourStep): string => step.targets[step.targets.length - 1]!;

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

/** Баннеры и предупреждения, раскрытые человеком на шаге «попробуйте»: на следующем шаге они сворачиваются. */
const EXPANDABLE = 'button.sum-card[aria-expanded="true"], button.warn-head[aria-expanded="true"]';

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
  mode = 'short',
  onClose,
  onMenu,
}: {
  open: boolean;
  /** short: восемь шагов первого показа, full: все подсказки по кнопке меню */
  mode?: TourMode;
  onClose: () => void;
  /** Открыть или закрыть меню из трёх точек: на шагах главы «Меню» оно открыто */
  onMenu?: (open: boolean) => void;
}) {
  return open ? <TourRun key={mode} mode={mode} onClose={onClose} onMenu={onMenu} /> : null;
}

function TourRun({
  mode,
  onClose,
  onMenu,
}: {
  mode: TourMode;
  onClose: () => void;
  onMenu?: (open: boolean) => void;
}) {
  const steps = stepsFor(mode);
  const router = useRouter();
  const pathname = usePathname();
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const startPath = useRef(pathname);
  const pathNow = useRef(pathname);
  pathNow.current = pathname;

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('seek');
  const [rect, setRect] = useState<Rect | null>(null);
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [asked, setAsked] = useState(false);
  const askedRef = useRef(false);
  const docPending = useRef(false);
  // сколько раз за шаг пришлось искать элемент заново: движок перезапускается, если он пропал
  const [restart, setRestart] = useState(0);
  // после ввода PIN (блокировка по простою посреди обучения) подготовка шага и поиск идут заново:
  // запросы, которые шли во время блокировки, вернули «введите PIN»
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const on = () => {
      docPending.current = false;
      setRetry((n) => n + 1);
      setRestart((n) => n + 1);
    };
    window.addEventListener(UNLOCKED_EVENT, on);
    return () => window.removeEventListener(UNLOCKED_EVENT, on);
  }, []);
  const targetRef = useRef<HTMLElement | null>(null);

  const step = steps[index]!;
  const stepRef = useRef(step);
  stepRef.current = step;
  const last = index === steps.length - 1;
  const tryMode = step.mode === 'try';
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

  // Закрытие только отсюда: кнопки «Пропустить обучение» и «Готово». Возврат на страницу, с которой начали.
  const finish = useCallback(() => {
    if (pathNow.current !== startPath.current) router.push(startPath.current);
    onClose();
  }, [onClose, router]);
  const next = useCallback(() => {
    if (last) finish();
    else setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [finish, last, steps.length]);
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  const latest = useRef({ finish, next, back });
  latest.current = { finish, next, back };

  // страница шага: переход, если шаг показан на другой странице; документ находим или создаём.
  // Кнопка «назад» браузера уводит на другую страницу, и тур возвращает на страницу шага.
  useEffect(() => {
    if (!step.path) return;
    if (step.path === 'document') {
      if (onStepPage(step, pathname) || docPending.current) return;
      docPending.current = true;
      void exampleDocument().then((id) => {
        docPending.current = false;
        // пока искали, человек мог уйти на другой шаг
        if (id && stepRef.current.path === 'document' && !onStepPage(stepRef.current, pathNow.current)) {
          router.push(`/documents/${id}`, { scroll: false });
        }
      });
      return;
    }
    if (pathname !== step.path) router.push(step.path);
  }, [step, pathname, router, retry]);

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
        const did = await askExample(() => alive, needOf(step));
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
  }, [step, pathname, retry]);

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

  /*
   * Движок шага. Пока элемент не найден и не стоит на месте, не показано ничего (phase 'seek').
   * Нашли и подвели: вырез и карточка вместе (phase 'ready'). Не нашли за отведённое время или он
   * не помещается в окно: карточка по центру без затемнения (phase 'fallback'); ждать элемент при
   * этом продолжаем, и если он появится, шаг переходит в 'ready'.
   */
  useEffect(() => {
    let alive = true;
    let raf = 0;
    const isAlive = () => alive;
    setPhase('seek');
    setRect(null);
    targetRef.current = null;
    // «попробуйте»: что раскрыл человек, на следующем шаге сворачивается
    const expandedBefore = new Set(document.querySelectorAll<HTMLElement>(EXPANDABLE));

    const find = () => (onStepPage(step, pathNow.current) ? findTarget(step) : null);

    void (async () => {
      // два кадра: сворачивание и закрытие того, что открывал прошлый шаг, успевает попасть в DOM, иначе
      // элемент находится ещё внутри закрывающегося блока (так терялась подсветка на шаге «Кнопки под цифрой»)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!alive) return;
      // Ждём дольше только пока пример готовится: ответ агента ещё не пришёл или окно расчёта грузится.
      // Если пример уже есть (ответ в истории) и нужного элемента в нём нет, карточка по центру через 3 секунды.
      const preparing =
        step.prepare === 'calc-profit' ||
        (step.prepare === 'chat-example' && !document.querySelector(needOf(step)));
      let el = await waitFor(find, isAlive, preparing ? WAIT_PREPARE_MS : WAIT_MS);
      if (!alive) return;
      if (!el) {
        // eslint-disable-next-line no-console
        console.warn(`[обучение] элемент шага «${step.id}» не найден, карточка показана по центру`);
        setPhase('fallback');
        el = await waitFor(find, isAlive, 60_000);
        if (!alive || !el) return;
      }
      // высота карточки (она уже в раскладке, пусть и скрыта) с зазором: места для неё под или над элементом
      const cardNeed = () => (cardRef.current?.offsetHeight ?? 0) + GAP;
      const fits = await settle(el, isAlive, cardNeed);
      if (!alive) return;
      if (!fits) {
        setPhase('fallback');
        return;
      }
      targetRef.current = el;
      setRect(measure(el));
      setPhase('ready');

      // следим за элементом: положение меняется при прокрутке и раскрытии; пропал или ушёл из окна
      // надолго, значит страница перестроилась, и движок идёт по кругу заново
      let lost = 0;
      const follow = () => {
        if (!alive) return;
        if (!el!.isConnected || !usable(el!)) {
          lost += 1;
        } else if (!inView(el!)) {
          lost += 1;
        } else {
          lost = 0;
          const m = measure(el!);
          setRect((cur) => (sameRect(cur, m) ? cur : m));
        }
        if (lost > 20) {
          setRestart((n) => n + 1);
          return;
        }
        raf = requestAnimationFrame(follow);
      };
      raf = requestAnimationFrame(follow);
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      // человек раскрыл баннер или предупреждение на шаге «попробуйте»: при уходе с шага сворачиваем
      // (перезапуск движка на том же шаге ничего не сворачивает)
      if (step.mode === 'try' && stepRef.current !== step) {
        for (const b of document.querySelectorAll<HTMLElement>(EXPANDABLE)) {
          if (!expandedBefore.has(b)) b.click();
        }
      }
    };
  }, [step, restart]);

  // карточка: место по размеру; пока не ready или fallback она скрыта и места не занимает
  const shown = phase !== 'seek';
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !shown) {
      setPos(null);
      return;
    }
    const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
    const target = phase === 'ready' ? rect : null;
    setPos(placeCard(target, card.offsetWidth, card.offsetHeight, view.w, view.h, Math.max(MARGIN, header + MARGIN / 2)));
  }, [rect, index, view, numbers, asked, phase, shown]);

  // фокус на основную кнопку шага: Enter идёт дальше. Пока карточка не поставлена на место, она
  // скрыта и фокус принять не может, поэтому ждём первого расчёта положения.
  const visible = pos !== null;
  useEffect(() => {
    if (!visible) return;
    cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true });
  }, [index, visible]);

  // страница под обучением недоступна: ни нажатий, ни фокуса, ни чтения с экрана. На шагах
  // «попробуйте» содержимое открыто, но вне выреза нажатия перехватывают щиты (см. разметку).
  const marked = useRef<HTMLElement[]>([]);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (opener.current === null) opener.current = document.activeElement as HTMLElement | null;
    for (const el of marked.current) {
      el.removeAttribute('inert');
      el.removeAttribute(OWN_INERT);
    }
    marked.current = [];
    for (const sel of BACKGROUND) {
      if (tryMode && sel === '.app-body') continue;
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (!el.hasAttribute('inert')) {
          el.setAttribute('inert', '');
          el.setAttribute(OWN_INERT, '');
          marked.current.push(el);
        }
      }
    }
  }, [tryMode, index, pathname]);
  useEffect(
    () => () => {
      for (const el of marked.current) {
        el.removeAttribute('inert');
        el.removeAttribute(OWN_INERT);
      }
      marked.current = [];
      const o = opener.current;
      if (o && o !== document.body && o.isConnected) o.focus({ preventScroll: true });
    },
    [],
  );

  // клавиатура: стрелки листают, Tab ходит по кнопкам карточки. Escape тур не закрывает, но и не
  // доходит до окон и меню под ним: их тур закрывает сам.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
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

  // фокус не уходит из карточки (клик мимо, программный фокус); подсвеченный элемент на шаге
  // «попробуйте» фокус принять может
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const card = cardRef.current;
      if (!card || !(e.target instanceof Node) || card.contains(e.target)) return;
      if (stepRef.current.mode === 'try' && targetRef.current?.contains(e.target)) return;
      card.querySelector<HTMLElement>('[data-tour-primary]')?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // Щиты: ловят нажатия вне выреза и ничего не закрывают. На шаге «показ» один на весь экран, на шаге
  // «попробуйте» четыре вокруг выреза: нажатие по подсвеченному элементу доходит до страницы.
  const shield = (style: React.CSSProperties, key: string) => (
    <div key={key} className="tour-block" aria-hidden="true" data-testid="tour-backdrop" style={style} />
  );
  const shields =
    tryMode && phase === 'ready' && rect
      ? [
          shield({ top: 0, left: 0, width: view.w, height: Math.max(0, rect.top) }, 'top'),
          shield(
            { top: rect.top + rect.height, left: 0, width: view.w, height: Math.max(0, view.h - rect.top - rect.height) },
            'bottom',
          ),
          shield({ top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }, 'left'),
          shield(
            { top: rect.top, left: rect.left + rect.width, width: Math.max(0, view.w - rect.left - rect.width), height: rect.height },
            'right',
          ),
        ]
      : [shield({ inset: 0 }, 'all')];

  return (
    <div className="tour" data-testid="tour" data-step={step.id} data-chapter={step.chapter} data-index={index} data-phase={phase} data-mode={tryMode ? 'try' : 'show'}>
      {shields}
      {phase === 'ready' && rect ? (
        <div
          key={step.id}
          className="tour-hole"
          aria-hidden="true"
          data-testid="tour-hole"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      ) : null}
      <div
        key={`card-${step.id}`}
        ref={cardRef}
        className={`tour-card${visible ? ' placed' : ''}`}
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
      >
        <p className="tour-count">
          <span data-testid="tour-count">
            Шаг {index + 1} из {steps.length}
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
            Пропустить обучение
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
