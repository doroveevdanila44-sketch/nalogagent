/** Страницы установленного приложения прокручивают окно. Чат прокручивается отдельно. */
export function usesDocumentScroll(): boolean {
  return typeof document !== 'undefined'
    && Boolean(document.querySelector('.app-viewport[data-document-scroll]:not([hidden])'))
    && !document.querySelector('.auth-screen')
    && window.matchMedia('(max-width: 899px) and (display-mode: standalone)').matches;
}

export function appScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return usesDocumentScroll()
    ? document.scrollingElement as HTMLElement | null
    : document.querySelector<HTMLElement>('.app-main');
}
