import { useLayoutEffect } from 'react';
import { PALETTE, THEME } from '@/lib/theme';

/** Светлый фон страницы в приложении: под панелью вкладок и за скруглёнными углами шапки. */
export const PAGE_BG_APP: string = PALETTE.bg;

/** Озеро шапки: все экраны после входа. Совпадает с theme_color манифеста */
export const THEME_APP: string = THEME.app;
/** Бордо экранов входа, PIN и блокировки по простою */
export const THEME_AUTH: string = THEME.auth;

/**
 * Обновляет метатег theme-color. Если pageBg равен null, фон страницы задаёт CSS.
 * PIN может открыться без смены маршрута, поэтому его цвет задаётся здесь.
 */
export function applyThemeColor(color: string, pageBg: string | null = color): void {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  } else {
    for (const meta of metas) meta.setAttribute('content', color);
  }
  if (pageBg !== null) {
    document.documentElement.style.backgroundColor = pageBg;
    document.body.style.backgroundColor = pageBg;
  }
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
export function useThemeColor(color: string, pageBg: string | null = color): void {
  useLayoutEffect(() => {
    applyThemeColor(color, pageBg);
    const reapply = () => {
      if (document.visibilityState === 'visible') applyThemeColor(color, pageBg);
    };
    document.addEventListener('visibilitychange', reapply);
    window.addEventListener('pageshow', reapply);
    return () => {
      document.removeEventListener('visibilitychange', reapply);
      window.removeEventListener('pageshow', reapply);
      if (pageBg !== null) clearPageBackground();
    };
  }, [color, pageBg]);
}
