/**
 * Прокручиваемая область приложения. Страница (html и body) не прокручивается: шапка и нижняя
 * панель вкладок стоят на месте, прокручивается только main (.app-main). Всё, что раньше трогало
 * прокрутку окна (положение при возврате, подсветка элемента в обучении), работает с ней.
 */
export function appScroller(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.app-main');
}
