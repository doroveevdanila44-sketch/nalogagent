'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, LOCKED_EVENT, UNLOCKED_EVENT, setCsrf } from '@/lib/client/api';
import { watchKeyboard } from '@/lib/client/keyboard';
import { THEME_APP, THEME_AUTH, useThemeColor } from '@/lib/client/theme-color';
import { Wordmark } from './Wordmark';
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
  const [sheet, setSheet] = useState<'none' | 'menu' | 'changePin'>('none');
  // PIN устройства заблокирован после пяти ошибок: на экране PIN слева появляется «Войти по паролю»
  const [pinBlocked, setPinBlocked] = useState(false);
  // Обучение: открывается один раз после первого входа и по кнопке «Показать подсказки заново» в меню
  const [tourOpen, setTourOpen] = useState(false);
  // первый показ идёт восемью шагами, «Показать подсказки заново» из меню открывает все подсказки
  const [tourMode, setTourMode] = useState<'short' | 'full'>('short');
  const onboardingChecked = useRef(false);
  // Полоса под часами: бордо на экране блокировки и смены PIN, озеро на остальных
  useThemeColor(locked || sheet === 'changePin' ? THEME_AUTH : THEME_APP);
  const pendingServerLock = useRef(false);
  const headerRef = useRef<HTMLElement>(null);
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

  // Экранная клавиатура: на телефоне прячет нижнюю панель и поднимает поле ввода (lib/client/keyboard.ts)
  useEffect(() => watchKeyboard(), []);

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
    document.querySelector<HTMLElement>('.app-main')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [section]);

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

  const tab = (href: string, label: string, icon: ReactNode) => (
    <Link
      href={href}
      className="tab"
      aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
      prefetch={false}
    >
      {icon}
      {label}
    </Link>
  );

  return (
    <>
      <div className="app-shell" hidden={locked} aria-hidden={locked} {...(locked ? { inert: true } : {})}>
        <header className="top" ref={headerRef}>
          {/* Метка демо: один раз в шапке, на всех экранах после входа */}
          <span className="demo-badge" data-testid="demo-badge">
            Демо-данные
          </span>
          <div className="wrap top-in">
            <Wordmark />
            <div className="top-actions">
              <button
                type="button"
                className="icon-btn"
                data-tour="menu-button"
                aria-label="Меню"
                aria-haspopup="dialog"
                onClick={() => setSheet('menu')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="5.5" r="1.2" />
                  <circle cx="12" cy="12" r="1.2" />
                  <circle cx="12" cy="18.5" r="1.2" />
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
          <main className="wrap app-main">{children}</main>
        </div>

        <nav className="tabs" aria-label="Разделы">
          {tab(
            '/agent',
            'Агент',
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
            </svg>,
          )}
          {tab(
            '/dashboard',
            'Дашборд',
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
              <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
              <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
              <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
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
