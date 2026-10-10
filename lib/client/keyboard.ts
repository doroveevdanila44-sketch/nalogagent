/**
 * Экранная клавиатура на телефоне. Следит за фокусом в текстовом поле и за размером вьюпорта и
 * выставляет на <html>:
 *  - data-kb="open", пока клавиатура видна (CSS прячет нижнюю панель вкладок);
 *  - --kb, высоту клавиатуры, которая перекрывает раскладочный вьюпорт.
 *
 * Два случая. Chrome на Android с interactive-widget=resizes-content сам уменьшает раскладочный
 * вьюпорт: fixed-элементы встают над клавиатурой, --kb равен 0, а раскладка на 100dvh сжимается.
 * Safari на iOS раскладочный вьюпорт не уменьшает, уменьшается только визуальный: тогда --kb
 * укорачивает чат на высоту клавиатуры, и поле ввода стоит над ней. Формула одна: innerHeight -
 * visualViewport.height - visualViewport.offsetTop (равна нулю там, где вьюпорт уже сжат или
 * Safari сам сдвинул страницу).
 *
 * Клавиатурой считается вьюпорт, уменьшившийся больше чем на 120 px при фокусе в текстовом поле
 * на устройстве с касанием: панель адреса и увеличение пальцами сюда не попадают.
 */
export const KEYBOARD_EVENT = 'pva:keyboard';

const THRESHOLD = 120;
const NON_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'image', 'color']);

function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

export function watchKeyboard(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const coarse = window.matchMedia('(pointer: coarse)');
  let baseInner = window.innerHeight;
  let open = false;

  const update = () => {
    const focused = isTextField(document.activeElement);
    const innerH = window.innerHeight;
    // Без фокуса вьюпорт свободен: запоминаем его высоту как «без клавиатуры»
    if (!focused) baseInner = innerH;

    const zoomed = vv ? vv.scale > 1.01 : false;
    // На сколько визуальный вьюпорт ниже раскладочного: есть клавиатура или нет, даже если Safari уже
    // сдвинул страницу вверх (offsetTop) и нижний край поля оказался над клавиатурой
    const reduced = vv && !zoomed ? Math.max(0, Math.round(innerH - vv.height)) : 0;
    // Сколько клавиатура ещё перекрывает раскладку: на это поднимается низ чата (до сдвига страницы)
    const covered = vv && !zoomed ? Math.max(0, Math.round(innerH - vv.height - vv.offsetTop)) : 0;
    const shrunk = Math.max(0, baseInner - innerH);
    const next = focused && coarse.matches && (reduced > THRESHOLD || shrunk > THRESHOLD);

    root.style.setProperty('--kb', next ? `${covered}px` : '0px');
    if (next) root.dataset.kb = 'open';
    else delete root.dataset.kb;

    // Событие и при каждом изменении, пока клавиатура открыта: список сообщений следует за вьюпортом
    if (next || open) window.dispatchEvent(new CustomEvent(KEYBOARD_EVENT, { detail: { open: next } }));
    open = next;
  };

  // После focusout activeElement ещё указывает на старое поле: читаем его в следующем такте
  const later = () => window.setTimeout(update, 0);

  document.addEventListener('focusin', update);
  document.addEventListener('focusout', later);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  update();

  return () => {
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', later);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    vv?.removeEventListener('resize', update);
    vv?.removeEventListener('scroll', update);
    delete root.dataset.kb;
    root.style.removeProperty('--kb');
  };
}
