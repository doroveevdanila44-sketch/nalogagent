'use client';

import { useEffect } from 'react';

const SAFE_BOTTOM = '--rr-safe-bottom';

export function standaloneDockInset(screenHeight: number, viewportHeight: number, safeTop: number): string | null {
  const missing = screenHeight - viewportHeight;

  // Старый полноэкранный ярлык: окно обрезано снизу, а inset индикатора относится к экрану.
  if (safeTop >= 20 && Math.abs(missing - safeTop) <= 4) {
    return `max(0px, calc(env(safe-area-inset-bottom, 0px) - ${missing}px))`;
  }

  // Системная полоса занимает верх экрана, а viewport-fit=auto может вернуть нулевой нижний inset.
  if (safeTop === 0 && missing >= 40 && missing <= 70) {
    return 'max(34px, env(safe-area-inset-bottom, 0px))';
  }

  return null;
}

export function RoborabViewport() {
  useEffect(() => {
    const ios = navigator as Navigator & { standalone?: boolean };
    if (!/iPhone/.test(ios.userAgent) || !(ios.standalone || matchMedia('(display-mode: standalone)').matches)) return;

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const update = () => {
      const { screen, innerWidth, innerHeight } = window;
      if (screen.width >= screen.height || Math.abs(screen.width - innerWidth) > 2) {
        root.style.removeProperty(SAFE_BOTTOM);
        return;
      }
      if (viewport && (Math.abs(viewport.scale - 1) > 0.01 || innerHeight - viewport.height > 80 || Math.abs(viewport.offsetTop) > 2)) return;

      const safeTop = Number.parseFloat(getComputedStyle(root).getPropertyValue('--rr-safe-top')) || 0;
      const inset = standaloneDockInset(screen.height, innerHeight, safeTop);
      if (inset) root.style.setProperty(SAFE_BOTTOM, inset);
      else root.style.removeProperty(SAFE_BOTTOM);
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('pageshow', update);
    viewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('pageshow', update);
      viewport?.removeEventListener('resize', update);
      root.style.removeProperty(SAFE_BOTTOM);
    };
  }, []);

  return null;
}
