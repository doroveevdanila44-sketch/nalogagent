import { computeKeyboard } from './viewport';

/**
 * Экранная клавиатура на телефоне. Слушает window.visualViewport (resize и scroll), фокус в
 * текстовом поле и размер окна и пишет на <html>:
 *  - --vvh, высоту видимой области в px. Оболочка берёт её (height: var(--vvh, 100dvh)): Safari на iOS
 *    и установленное на экран приложение не умеют interactive-widget=resizes-content, при открытой
 *    клавиатуре у них уменьшается только visualViewport, а 100vh и 100dvh остаются прежними;
 *  - --kb, высоту клавиатуры в px (0, пока её нет). Больше 80 px: прячется нижняя панель вкладок,
 *    сворачиваются «Подсказки»;
 *  - --vv-top, на сколько Safari сдвинул видимую область вниз по странице (visualViewport.offsetTop),
 *    пока клавиатура открыта. Оболочка встаёт ровно на видимую область: без поправки шапка уезжает
 *    выше видимой части, и под часами видны сообщения чата;
 *  - data-kb="open", пока клавиатура видна.
 * Формулы в viewport.ts (computeKeyboard), там же юнит-тест.
 *
 * Страница сама не прокручивается (html и body overflow: hidden), но iOS при фокусе всё равно сдвигает
 * окно, чтобы показать поле. Поэтому на blur и на каждом resize visualViewport окно возвращается в
 * (0, 0), а поле ввода чата через 150 и 350 мс после фокуса (клавиатура выезжает анимацией) снова
 * ставится в нижний край и список сообщений прокручивается к последнему сообщению.
 */
export const KEYBOARD_EVENT = 'pva:keyboard';

/** Клавиатура анимируется, поэтому положение поля уточняется дважды, а после blur вьюпорт перечитывается. */
const SETTLE_MS = [150, 350] as const;

const NON_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'image', 'color']);

function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Убирает автопрокрутку страницы, которую делает iOS: окно возвращается в (0, 0). Оболочка, её тело и
 * колонка чата не прокручиваются по замыслу (прокручивается только список сообщений, а в других
 * разделах main), поэтому их сдвиг, который мог оставить scrollIntoView, тоже снимается.
 */
export function resetPageScroll(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  const root = document.scrollingElement;
  if (root && root.scrollTop !== 0) root.scrollTop = 0;
  for (const el of document.querySelectorAll<HTMLElement>('.app-shell, .app-body, .chat-root, .app-main:has(> .chat-root)')) {
    if (el.scrollTop !== 0) el.scrollTop = 0;
  }
}

export function watchKeyboard(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const coarse = window.matchMedia('(pointer: coarse)');
  let baseInner = window.innerHeight;
  let open = false;
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  const update = () => {
    const focused = isTextField(document.activeElement);
    const innerH = window.innerHeight;
    // Без фокуса окно свободно: запоминаем его высоту как «без клавиатуры»
    if (!focused) baseInner = innerH;

    const g = computeKeyboard({
      innerHeight: innerH,
      vvHeight: vv ? vv.height : null,
      vvOffsetTop: vv ? vv.offsetTop : 0,
      vvScale: vv ? vv.scale : 1,
      baseInnerHeight: baseInner,
      focusedText: focused,
      coarse: coarse.matches,
    });

    if (g.vvh === null) root.style.removeProperty('--vvh');
    else root.style.setProperty('--vvh', `${g.vvh}px`);
    root.style.setProperty('--kb', `${g.kb}px`);
    root.style.setProperty('--vv-top', `${g.top}px`);
    if (g.open) root.dataset.kb = 'open';
    else delete root.dataset.kb;

    // Событие и при каждом изменении, пока клавиатура открыта: список сообщений следует за вьюпортом
    if (g.open || open) window.dispatchEvent(new CustomEvent(KEYBOARD_EVENT, { detail: { open: g.open } }));
    open = g.open;
  };

  /** Видимая область изменилась (клавиатура выезжает, Safari сдвигает страницу): перечитать и вернуть окно на место. */
  const onViewport = () => {
    update();
    resetPageScroll();
  };

  /** Поле, взявшее фокус, встаёт в нижний край видимой области; для чата ещё и список к последнему сообщению. */
  const settle = (field: Element) => {
    if (!(field instanceof HTMLElement) || document.activeElement !== field) return;
    update();
    if (field.closest('.composer')) {
      field.scrollIntoView({ block: 'end' });
      const list = document.querySelector<HTMLElement>('.chat-scroll');
      if (list) list.scrollTop = list.scrollHeight;
    } else if (!field.closest('[data-form]')) {
      // поля карточки сценария встают на место сами (FleetFormView), остальные просто видны
      field.scrollIntoView({ block: 'nearest' });
    }
    resetPageScroll();
  };

  const onFocusIn = (e: Event) => {
    update();
    const field = e.target;
    if (!(field instanceof Element) || !isTextField(field)) return;
    for (const ms of SETTLE_MS) later(() => settle(field), ms);
  };

  // После focusout activeElement ещё указывает на старое поле: читаем его в следующем такте. iOS после
  // закрытия клавиатуры иногда оставляет старую высоту visualViewport и сдвиг окна: перечитываем ещё дважды
  const onFocusOut = () => {
    later(onViewport, 0);
    for (const ms of SETTLE_MS) later(onViewport, ms);
  };

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', update);
  update();

  return () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('orientationchange', onViewport);
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', update);
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    delete root.dataset.kb;
    root.style.removeProperty('--vvh');
    root.style.removeProperty('--kb');
    root.style.removeProperty('--vv-top');
  };
}
