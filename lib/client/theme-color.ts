import { useLayoutEffect } from 'react';

/** Янтарь шапки: все экраны после входа. Совпадает с theme_color манифеста */
export const THEME_APP = '#CA9C68';
/** Коричневый экранов входа, PIN и блокировки по простою */
export const THEME_AUTH = '#594C3D';

/**
 * Записывает цвет в <meta name="theme-color">. Метатег Next.js выводит один раз на маршрут, а экран
 * блокировки открывается поверх приложения без смены маршрута, поэтому цвет меняется из кода.
 */
export function applyThemeColor(color: string): void {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
    return;
  }
  for (const meta of metas) meta.setAttribute('content', color);
}

/**
 * Цвет верхней полосы для экрана, пока компонент смонтирован. Применяется при монтировании и при
 * смене цвета (блокировка и разблокировка), повторно при возврате приложения из фона
 * (visibilitychange, pageshow): система могла сбросить полосу, пока страница была скрыта.
 * Следующий экран сам выставит свой цвет, поэтому при размонтировании ничего не возвращается.
 */
export function useThemeColor(color: string): void {
  useLayoutEffect(() => {
    applyThemeColor(color);
    const reapply = () => {
      if (document.visibilityState === 'visible') applyThemeColor(color);
    };
    document.addEventListener('visibilitychange', reapply);
    window.addEventListener('pageshow', reapply);
    return () => {
      document.removeEventListener('visibilitychange', reapply);
      window.removeEventListener('pageshow', reapply);
    };
  }, [color]);
}
