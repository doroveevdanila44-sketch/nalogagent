/**
 * Геометрия экранной клавиатуры по значениям окна и visualViewport. Чистая функция без обращения к
 * странице: по ней keyboard.ts выставляет --vvh, --kb и --vv-top, а юнит-тест проверяет формулы на
 * числах iPhone, не имея настоящей клавиатуры.
 *
 * Safari на iOS и установленное на экран приложение не умеют interactive-widget=resizes-content: при
 * открытии клавиатуры раскладочный вьюпорт (innerHeight, 100vh, 100dvh) не меняется, уменьшается
 * только visualViewport, а Safari ещё и сдвигает видимую область вниз по странице (offsetTop), чтобы
 * показать поле. Поэтому высота оболочки берётся из visualViewport, а не из 100dvh.
 * Chrome на Android, наоборот, сам сжимает раскладочный вьюпорт: тогда visualViewport.height равен
 * innerHeight, а клавиатуру выдаёт уменьшение innerHeight против того, что было без неё.
 */

/** Клавиатурой считается уменьшение видимой области больше чем на столько пикселей. */
export const KEYBOARD_THRESHOLD = 80;

export interface ViewportMetrics {
  /** window.innerHeight */
  innerHeight: number;
  /** visualViewport.height; null: у браузера нет visualViewport */
  vvHeight: number | null;
  /** visualViewport.offsetTop: на сколько видимая область сдвинута вниз по раскладочному вьюпорту */
  vvOffsetTop: number;
  /** visualViewport.scale: больше 1 при увеличении пальцами */
  vvScale: number;
  /** innerHeight, когда фокуса в текстовом поле не было: «без клавиатуры» */
  baseInnerHeight: number;
  /** Фокус в текстовом поле */
  focusedText: boolean;
  /** Устройство с касанием: на компьютере клавиатуры в этом смысле нет */
  coarse: boolean;
}

export interface KeyboardGeometry {
  /** Клавиатура видна */
  open: boolean;
  /** Высота видимой области, px: в --vvh. null: увеличение пальцами или нет visualViewport, переменная снимается и оболочка берёт 100dvh */
  vvh: number | null;
  /** Высота клавиатуры, px: в --kb. 0, пока клавиатуры нет */
  kb: number;
  /** Сдвиг видимой области вниз по странице, px: в --vv-top. Только при открытой клавиатуре */
  top: number;
}

const px = (n: number): number => Math.max(0, Math.round(n));

export function computeKeyboard(m: ViewportMetrics): KeyboardGeometry {
  const zoomed = m.vvScale > 1.01;
  // При увеличении пальцами visualViewport уменьшается сам: клавиатурой это не считается
  if (zoomed) return { open: false, vvh: null, kb: 0, top: 0 };

  // На сколько видимая область ниже раскладочной: клавиатура есть, даже если Safari сдвинул страницу
  const reduced = m.vvHeight === null ? 0 : px(m.innerHeight - m.vvHeight);
  // На сколько сжался сам раскладочный вьюпорт (Chrome на Android)
  const shrunk = px(m.baseInnerHeight - m.innerHeight);
  const open = m.focusedText && m.coarse && (reduced > KEYBOARD_THRESHOLD || shrunk > KEYBOARD_THRESHOLD);

  return {
    open,
    vvh: m.vvHeight === null ? null : px(m.vvHeight),
    kb: open ? Math.max(reduced, shrunk) : 0,
    top: open ? px(m.vvOffsetTop) : 0,
  };
}
