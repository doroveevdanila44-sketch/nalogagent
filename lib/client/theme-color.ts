import { useLayoutEffect } from 'react';
import { THEME } from '@/lib/theme';

/** Озеро шапки: все экраны после входа. Совпадает с theme_color манифеста */
export const THEME_APP: string = THEME.app;
/** Бордо экранов входа, PIN и блокировки по простою */
export const THEME_AUTH: string = THEME.auth;

/**
 * Записывает цвет в <meta name="theme-color"> и красит страницу под часами: фон <html> (виден под
 * вырезом при установленном приложении с black-translucent и при оттягивании страницы) и, на экранах
 * входа, фон <body>. Метатег Next.js выводит один раз на маршрут, а экран блокировки открывается
 * поверх приложения без смены маршрута, поэтому цвет меняется из кода. В приложении страница (body)
 * остаётся белой, под часами лежит шапка с отступом safe-area-inset-top.
 */
export function applyThemeColor(color: string): void {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  } else {
    for (const meta of metas) meta.setAttribute('content', color);
  }
  document.documentElement.style.backgroundColor = color;
  document.body.style.backgroundColor = color === THEME_AUTH ? color : '';
}

/** Возвращает фон <html> и <body> стилям страницы: экран без этого хука красят таблицы стилей. */
function clearPageBackground(): void {
  document.documentElement.style.removeProperty('background-color');
  document.body.style.removeProperty('background-color');
}

/**
 * Цвет верхней полосы для экрана, пока компонент смонтирован. Применяется при монтировании и при
 * смене цвета (блокировка и разблокировка), повторно при возврате приложения из фона
 * (visibilitychange, pageshow): система могла сбросить полосу, пока страница была скрыта.
 * Метатег при размонтировании не возвращается: следующий экран сам выставит свой цвет. Фон html и
 * body возвращается стилям страницы.
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
      clearPageBackground();
    };
  }, [color]);
}
