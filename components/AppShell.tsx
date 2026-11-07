'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, LOCKED_EVENT, UNLOCKED_EVENT, setCsrf } from '@/lib/client/api';
import { PAGE_BG_APP, THEME_APP, THEME_AUTH, useThemeColor } from '@/lib/client/theme-color';
import { attachRoborabHeader } from '@/app/roborab-header.js';
import { PinPad, type PinResult } from './auth/PinPad';
import { ChangePin } from './auth/ChangePin';
import { Tour } from './onboarding/Tour';

export { UNLOCKED_EVENT };

interface Props {
  children: ReactNode;
  csrf: string;
  idleMinutes: number;
  backgroundSeconds: number;
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

export function AppShell({ children, csrf, idleMinutes, backgroundSeconds }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [locked, setLocked] = useState(false);
  const [online, setOnline] = useState(true);
  const [headerGlass, setHeaderGlass] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'menu' | 'changePin'>('none');
  // PIN устройства заблокирован после пяти ошибок: на экране PIN слева появляется «Войти по паролю»
  const [pinBlocked, setPinBlocked] = useState(false);
  // Обучение: открывается один раз после первого входа и по кнопке «Показать подсказки заново» в меню
  const [tourOpen, setTourOpen] = useState(false);
  // первый показ идёт восемью шагами, «Показать подсказки заново» из меню открывает все подсказки
  const [tourMode, setTourMode] = useState<'short' | 'full'>('short');
  const onboardingChecked = useRef(false);
  const authLook = locked || sheet === 'changePin';
  const canHideHeader = online && !locked && sheet === 'none' && !tourOpen;
  useThemeColor(authLook ? THEME_AUTH : canHideHeader && headerGlass ? PAGE_BG_APP : THEME_APP, authLook ? THEME_AUTH : PAGE_BG_APP);
  const pendingServerLock = useRef(false);
  const headerRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // CSRF-токен текущей сессии: layout-эффекты выполняются раньше эффектов дочерних компонентов
  useLayoutEffect(() => {
    setCsrf(csrf);
  }, [csrf]);

  const sendLock = useCallback(async () => {
    try {
      await api('/api/auth/lock', { method: 'POST', body: {} });
      pendingServerLock.current = false;
    } catch {
      // нет сети: экран уже закрыт локально, сервер заблокирует сессию по простою
      pendingServerLock.current = true;
    }
  }, []);

  const lockNow = useCallback(() => {
    setSheet('none');
    setLocked(true);
    void sendLock();
  }, [sendLock]);

  // ----- блокировка по простою, сворачиванию и закрытию вкладки -----
  useEffect(() => {
    if (locked) return;
    const idleMs = idleMinutes * 60_000;
    const bgMs = backgroundSeconds * 1000;
    let lastActivity = Date.now();
    let hiddenAt: number | null = null;
    let lastPing = Date.now();

    const bump = () => {
      lastActivity = Date.now();
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { passive: true, capture: true });

    const tick = window.setInterval(() => {
      const now = Date.now();
      if (now - lastActivity >= idleMs) {
        lockNow();
        return;
      }
      // Пока пользователь активен, отмечаем это на сервере раз в минуту (GET /api/auth/state)
      if (now - lastPing >= 60_000 && now - lastActivity < 60_000 && document.visibilityState === 'visible') {
        lastPing = now;
        void api('/api/auth/state').catch(() => undefined);
      }
    }, 1000);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const now = Date.now();
      const away = hiddenAt !== null ? now - hiddenAt : 0;
      hiddenAt = null;
      if (away >= bgMs || now - lastActivity >= idleMs) lockNow();
      else lastActivity = now;
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Закрытие вкладки: блокируем на сервере через sendBeacon. bfcache (persisted) не считается закрытием.
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      try {
        navigator.sendBeacon('/api/auth/lock', new Blob(['{}'], { type: 'application/json' }));
      } catch {
        // без маяка сервер сам заблокирует сессию по простою
      }
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, bump, { capture: true });
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [locked, idleMinutes, backgroundSeconds, lockNow]);

  // ----- сигнал «locked» от API, сеть, service worker -----
  useEffect(() => {
    const onLocked = () => setLocked(true);
    const goOnline = () => {
      setOnline(true);
      if (pendingServerLock.current) void sendLock();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener(LOCKED_EVENT, onLocked);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener(LOCKED_EVENT, onLocked);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [sendLock]);

  // Экранная клавиатура слушается из корневого layout (components/KeyboardViewport.tsx)

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    }
  }, []);

  // Прокручивается область main, а не окно, и она одна на все разделы: при переходе в другой раздел
  // (дашборд, документы, агент) содержимое открывается с начала. Список и лист документов внутри
  // раздела «Документы» сохраняют положение сами (DocumentsShell).
  const section = pathname.split('/')[1] ?? '';
  const lastSection = useRef(section);
  useLayoutEffect(() => {
    if (lastSection.current === section) return;
    lastSection.current = section;
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [section]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const status = statusRef.current;
    if (!canHideHeader || !header || !status) return;
    return attachRoborabHeader(header, status, {
      scrollSelector: '.app-main, .app-main .chat-scroll',
      paused: () => document.documentElement.dataset.kb === 'open',
      onGlass: setHeaderGlass,
    });
  }, [canHideHeader, pathname]);

  // Высота шапки (она растёт, когда показан баннер «Нет сети»): боковая панель и нижние элементы
  // привязаны к ней через CSS-переменную --header-h
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    // border-box: отступ safe-area лежит в padding шапки, при повороте экрана он меняется, а
    // content-box нет, и без этого --header-h (на нём высота чата) оставалась бы прежней
    ro.observe(el, { box: 'border-box' });
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--header-h');
    };
  }, [locked]);

  // Пока открыт полноэкранный PIN, страница под ним не прокручивается: полоса прокрутки не сдвигает
  // центр экрана PIN и не остаётся видимой
  useEffect(() => {
    if (!locked && sheet !== 'changePin') return;
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = prev;
    };
  }, [locked, sheet]);

  // Меню: фокус на первый пункт, Escape закрывает
  useEffect(() => {
    if (sheet !== 'menu') return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet('none');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);

  // «Пройдено» хранится в базе (user_prefs), а не в браузере: обучение не повторяется на другом
  // устройстве и после очистки данных сайта. Успешный ответ запоминается: дальше не спрашиваем.
  useEffect(() => {
    if (locked || onboardingChecked.current) return;
    let cancelled = false;
    api<{ onboardingSeenAt: string | null }>('/api/prefs')
      .then((p) => {
        if (cancelled) return;
        onboardingChecked.current = true;
        if (p.onboardingSeenAt === null) {
          setTourMode('short');
          setTourOpen(true);
        }
      })
      .catch(() => {
        // не удалось узнать: обучение не показываем, при следующем запуске спросим снова
      });
    return () => {
      cancelled = true;
    };
  }, [locked]);

  const closeTour = useCallback(() => {
    setTourOpen(false);
    // любое закрытие (пройдено, пропущено, Escape) считается показом: повторно только из меню
    void api('/api/prefs', { body: { onboardingSeen: true } }).catch(() => undefined);
  }, []);

  // Обучение открывает и закрывает меню на шагах главы «Меню»; смену PIN и блокировку не трогает
  const toggleMenuForTour = useCallback((open: boolean) => {
    setSheet((s) => (open ? (s === 'none' ? 'menu' : s) : s === 'menu' ? 'none' : s));
  }, []);

  const unlock = useCallback(async (pin: string): Promise<PinResult> => {
    try {
      const res = await api<{ csrf: string }>('/api/auth/pin', { body: { pin } });
      setCsrf(res.csrf);
      setPinBlocked(false);
      setLocked(false);
      window.dispatchEvent(new CustomEvent(UNLOCKED_EVENT));
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'pin_blocked') {
          setPinBlocked(true);
          return { ok: false, error: e.message };
        }
        if (e.code === 'need_password' || e.code === 'unauthorized') {
          window.location.assign('/login?mode=password');
          return { ok: true };
        }
        return { ok: false, error: e.code === 'network' ? 'Нет связи с сервером' : e.message };
      }
      return { ok: false, error: 'Не удалось проверить PIN' };
    }
  }, []);

  const goPassword = useCallback(() => window.location.assign('/login?mode=password'), []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      // даже при ошибке уходим на экран входа: сессия закроется по сроку
    }
    window.location.assign('/login');
  }, []);

  // Плитки тачбара: только иконки, подпись скрыта визуально и остаётся для экранных читалок (DESIGN.md, 10.2)
  const tab = (href: string, label: string, icon: ReactNode) => (
    <Link
      href={href}
      className="tab rr-tab"
      aria-label={label}
      aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
      prefetch={false}
    >
      {icon}
      <span className="tab-label rr-tab-label">{label}</span>
    </Link>
  );

  return (
    <>
      <div className="app-shell" hidden={locked} aria-hidden={locked} {...(locked ? { inert: true } : {})}>
        <div ref={statusRef} className="rr-scroll-status" aria-hidden="true" />
        <header className="top rr-header" ref={headerRef} data-rr-scroll-header="">
          <div className="top-in rr-header-row">
            <span className="wordmark rr-wordmark">РОБОРАБ</span>
            <div className="top-actions">
              <button
                type="button"
                className="icon-btn rr-header-action"
                data-tour="menu-button"
                aria-label="Меню"
                aria-haspopup="dialog"
                onClick={() => setSheet('menu')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="5" r="1" />
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="12" cy="19" r="1" />
                </svg>
              </button>
            </div>
          </div>
          {!online && (
            <div className="offline-banner" role="status">
              Нет сети
            </div>
          )}
        </header>

        <div className="app-body">
          <main className="wrap app-main" ref={mainRef}>{children}</main>
        </div>

        <nav className="tabs rr-dock rr-rail" aria-label="Разделы">
          {tab(
            '/agent',
            'Агент',
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
            </svg>,
          )}
          {tab(
            '/dashboard',
            'Дашборд',
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 20V14M12 20V10M18 20V4" />
            </svg>,
          )}
          {tab(
            '/documents',
            'Документы',
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
              <path d="M14 3.5V8h4M8.5 12.5h7M8.5 16h5" />
            </svg>,
          )}
        </nav>

        {/* Сюда выводятся окна расчёта, проверки и передачи: при блокировке они прячутся со страницей */}
        <div id="overlay-root" />

        {/* При блокировке на PIN обучение прячется вместе со страницей и возвращается после ввода PIN */}
        <Tour open={tourOpen} mode={tourMode} onClose={closeTour} onMenu={toggleMenuForTour} />
      </div>

      {sheet === 'menu' && !locked && (
        <div className="sheet-backdrop" onClick={() => setSheet('none')}>
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Меню"
            data-tour="menu-sheet"
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="row" data-tour="menu-lock" onClick={lockNow}>
              Заблокировать
            </button>
            <button
              type="button"
              className="row"
              onClick={() => {
                setSheet('none');
                router.push('/statuses');
              }}
            >
              Что проверено
            </button>
            <button type="button" className="row" data-tour="menu-pin" onClick={() => setSheet('changePin')}>
              Сменить PIN
            </button>
            <button
              type="button"
              className="row"
              data-action="tour"
              data-tour="menu-tour"
              onClick={() => {
                setSheet('none');
                setTourMode('full');
                setTourOpen(true);
              }}
            >
              Показать подсказки заново
            </button>
            <button type="button" className="row danger" onClick={logout}>
              Выйти
            </button>
            <button type="button" className="row row-close" onClick={() => setSheet('none')}>
              Закрыть
            </button>
          </div>
        </div>
      )}

      {sheet === 'changePin' && !locked && <ChangePin onClose={() => setSheet('none')} />}

      {locked && (
        <div className="auth-screen auth-overlay pin-mode" role="dialog" aria-modal="true" aria-label="Ввод PIN">
          <PinPad
            title="Введите PIN"
            onSubmit={unlock}
            blocked={pinBlocked}
            onPassword={goPassword}
            onCancel={goPassword}
          />
        </div>
      )}
    </>
  );
}
