'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { ChatTurn } from '@/lib/agent/types';
import { api, ApiError } from '@/lib/client/api';
import { ASK_EVENT } from '@/lib/client/ask';
import { KEYBOARD_EVENT } from '@/lib/client/keyboard';
import { useMediaQuery } from '@/lib/client/media';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { Message } from './Message';

const SUGGESTIONS = [
  'Какая ставка выгоднее?',
  'Сколько платить за квартал?',
  'Что с порогами?',
  'Налог на прибыль за год?',
];

type Pending = { key: number; text: string };

/** Высота поля в одну строку; потолок (шесть строк) задан в CSS как max-height, дальше прокрутка внутри */
const FIELD_MIN = 38;

/** Сколько пикселей подряд в одну сторону считается листанием, после которого меняется блок подсказок */
const SCROLL_STEP = 24;

/** Телефон: до 760 px, как граница боковой панели в CSS */
const PHONE_QUERY = '(max-width: 759.98px)';

const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Нажатие не отбирает фокус у поля, поэтому экранная клавиатура остаётся открытой. preventDefault
 * на pointerdown и на mousedown: касание порождает оба события, и браузеры расходятся в том, какое
 * из них переводит фокус.
 */
const holdFocus = (e: PointerEvent | MouseEvent) => e.preventDefault();

/**
 * Вкладка «Агент». История хранится в базе, при заходе подгружаются последние 50.
 *
 * Раскладка на высоту окна, три части в колонке: список сообщений (единственная прокручиваемая
 * область), блок подсказок, поле ввода. Страница целиком не прокручивается, поэтому прокрутка
 * списка при открытой клавиатуре не сдвигает страницу и не закрывает клавиатуру. Нигде в чате
 * не вызывается blur(), фокус с поля не снимается ни при прокрутке, ни при нажатии на сообщения,
 * кнопки и подсказки. Список прокручивается только свой собственный (scrollTop), не окно.
 *
 * Поле ввода как в приложении Claude: textarea растёт от 38 px до шести строк, дальше внутренняя
 * прокрутка. На компьютере Enter отправляет, Shift+Enter переносит строку; на телефоне Enter
 * переносит строку, отправка только кнопкой. Без родительского form и без других полей ввода на
 * экране: так Safari не рисует над клавиатурой стрелки «вверх, вниз» (см. DECISIONS.md).
 *
 * Подсказки на компьютере: все, пока клавиатура закрыта; при открытой клавиатуре и при листании вниз
 * блок сворачивается до ручки «Подсказки», листание вверх разворачивает его, если клавиатура закрыта.
 * На телефоне (до 760 px) блок свёрнут по умолчанию и раскрывается только нажатием на ручку: ни
 * прокрутка списка, ни закрытие клавиатуры, ни новый ответ агента его не раскрывают. После выбора
 * подсказки блок сворачивается.
 */
export function ChatView() {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<Pending | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  const [chipsOpen, setChipsOpen] = useState(true);
  // телефон: своё состояние, управляется только ручкой и выбором подсказки
  const phone = useMediaQuery(PHONE_QUERY);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const suggestionsOpen = phone ? phoneOpen : chipsOpen;
  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const hadFocus = useRef(false);
  const kbOpenRef = useRef(false);

  // Состояние прокрутки списка: расстояние от нижнего края, последний scrollTop, ожидаемый scrollTop
  // после нашей прокрутки (чтобы отличить её от жеста), накопленный сдвиг, окно «листает пользователь»
  const bottomGap = useRef(0);
  const lastTop = useRef(0);
  const expectedTop = useRef<number | null>(null);
  const travelled = useRef(0);
  const userUntil = useRef(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api<{ messages: ChatTurn[] }>('/api/chat');
      setTurns(res.messages);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'locked') return;
      setLoadError(e instanceof ApiError && e.code === 'network' ? 'Нет связи с сервером' : 'Не удалось загрузить историю');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUnlocked = () => void load();
    window.addEventListener(UNLOCKED_EVENT, onUnlocked);
    return () => window.removeEventListener(UNLOCKED_EVENT, onUnlocked);
  }, [load]);

  /** Прокрутка списка в самый низ. Только контейнер списка: окно и страница не двигаются */
  const scrollToEnd = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    expectedTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
    bottomGap.current = 0;
  }, []);

  // Новое сообщение, ответ, индикатор набора и первая загрузка истории: в самый низ списка
  useLayoutEffect(() => {
    scrollToEnd();
  }, [turns, sending, scrollToEnd]);

  // Список меняет высоту (клавиатура, свёрнутые подсказки, выросшее поле): остаётся на том же
  // расстоянии от нижнего края, поэтому последнее сообщение не уезжает
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const top = Math.max(0, el.scrollHeight - el.clientHeight - bottomGap.current);
      el.scrollTop = top;
      expectedTop.current = el.scrollTop;
      lastTop.current = el.scrollTop;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Клавиатура закрылась системным жестом (поле осталось в фокусе): подсказки возвращаются
  useEffect(() => {
    const onKeyboard = (e: Event) => {
      const open = Boolean((e as CustomEvent<{ open: boolean }>).detail?.open);
      if (!open) setKbOpen(false);
      else if (document.activeElement === fieldRef.current) setKbOpen(true);
    };
    window.addEventListener(KEYBOARD_EVENT, onKeyboard);
    return () => window.removeEventListener(KEYBOARD_EVENT, onKeyboard);
  }, []);

  // Клавиатура открылась: подсказки сворачиваются; закрылась: разворачиваются
  useEffect(() => {
    kbOpenRef.current = kbOpen;
    setChipsOpen(!kbOpen);
  }, [kbOpen]);

  /**
   * Жест на списке: вниз сворачивает подсказки, вверх разворачивает, если клавиатура закрыта.
   * Прокрутка нашим же кодом (в низ, сохранение расстояния) и сдвиги, вызванные изменением высоты,
   * жестом не считаются: иначе сворачивание подсказок само вызывало бы разворачивание.
   */
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // Прокрутка нашим кодом: расстояние от нижнего края мы задали сами. Событие приходит позже и
    // может застать уже другую высоту списка (клавиатура), поэтому по нему расстояние не пересчитываем.
    if (expectedTop.current !== null && Math.abs(top - expectedTop.current) < 1) {
      expectedTop.current = null;
      lastTop.current = top;
      return;
    }
    expectedTop.current = null;
    bottomGap.current = Math.max(0, el.scrollHeight - el.clientHeight - top);
    const delta = top - lastTop.current;
    lastTop.current = top;
    if (delta === 0 || performance.now() > userUntil.current) {
      travelled.current = 0;
      return;
    }
    travelled.current = Math.sign(travelled.current) === Math.sign(delta) ? travelled.current + delta : delta;
    if (travelled.current >= SCROLL_STEP) {
      travelled.current = 0;
      setChipsOpen(false);
    } else if (travelled.current <= -SCROLL_STEP) {
      travelled.current = 0;
      if (!kbOpenRef.current) setChipsOpen(true);
    }
  }, []);

  // Окно, в котором прокрутка считается жестом пользователя: пока палец на экране и 1,5 с инерции
  const touching = () => {
    userUntil.current = Number.POSITIVE_INFINITY;
  };
  const released = () => {
    userUntil.current = performance.now() + 1500;
  };
  const wheeled = () => {
    userUntil.current = performance.now() + 300;
  };

  /** Высота по содержимому: от одной строки до max-height из CSS; выше потолка включается прокрутка */
  const fit = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    // Пустое поле всегда в одну строку: длинная подсказка-placeholder на узком экране переносится
    // и иначе раздула бы высоту
    if (el.value === '') {
      el.style.height = `${FIELD_MIN}px`;
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.max(FIELD_MIN, Math.min(full, max))}px`;
    el.style.overflowY = full > max ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [draft, fit]);

  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);

  const send = useCallback(
    async (raw: string, baseId?: number) => {
      const text = raw.trim();
      if (!text || sending) return;
      setSendError(null);
      // текст в поле ввода не трогаем, если сообщение ушло с кнопки
      if (baseId === undefined) setDraft('');
      setSending({ key: Date.now(), text });
      try {
        const res = await api<{ user: ChatTurn; agent: ChatTurn }>('/api/chat', {
          body: baseId === undefined ? { message: text } : { message: text, baseId },
        });
        setTurns((prev) => [...(prev ?? []), res.user, res.agent]);
      } catch (e) {
        if (baseId === undefined) setDraft(text);
        if (e instanceof ApiError && e.code === 'locked') {
          // PIN-экран поверх, текст остаётся в поле
        } else if (e instanceof ApiError && e.code === 'network') {
          setSendError('Нет связи с сервером. Сообщение не отправлено.');
        } else {
          setSendError('Не удалось получить ответ. Повторите.');
        }
      } finally {
        setSending(null);
      }
    },
    [sending],
  );

  // Обучение просит задать вопрос агенту на примере: тем же путём, что и кнопка «Отправить»
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) void sendRef.current(text);
    };
    window.addEventListener(ASK_EVENT, on);
    return () => window.removeEventListener(ASK_EVENT, on);
  }, []);

  const empty = turns !== null && turns.length === 0 && !sending;

  /** Кнопки под полем: если поле было в фокусе, оно остаётся в нём и клавиатура не закрывается */
  const down = (e: PointerEvent | MouseEvent) => {
    if (e.type === 'pointerdown') hadFocus.current = document.activeElement === fieldRef.current;
    holdFocus(e);
  };
  const press = (text: string) => {
    void send(text);
    if (phone) setPhoneOpen(false);
    if (hadFocus.current) fieldRef.current?.focus();
    hadFocus.current = false;
  };

  /** Кнопка под ответом: быстрый ответ или выбор в «Изменить». Фокус поля остаётся как был. */
  const pickQuick = (text: string, baseId: number) => {
    const had = document.activeElement === fieldRef.current;
    void send(text, baseId);
    if (had) fieldRef.current?.focus();
  };

  const onFieldKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    // На телефоне Enter переносит строку: отправляет только кнопка
    if (isCoarse()) return;
    e.preventDefault();
    void send(draft);
  };

  /**
   * На телефоне нажатие на любую часть чата, кроме самого поля, не берёт фокус и не снимает его с поля:
   * по пустой области, по сообщениям и по списку клавиатура не закрывается. Клик по элементам при этом
   * срабатывает как обычно, а клавиатура закрывается только жестом самой системы.
   */
  const onRootMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (isCoarse() && e.target !== fieldRef.current) e.preventDefault();
  };

  const suggestionButton = (s: string, disabled = false) => (
    <button
      key={s}
      type="button"
      onPointerDown={down}
      onMouseDown={down}
      onClick={() => press(s)}
      disabled={disabled}
    >
      {s}
    </button>
  );

  return (
    <div className="chat-root" data-ready={turns !== null} onMouseDown={onRootMouseDown}>
      <div
        className="chat-scroll"
        ref={listRef}
        onScroll={onListScroll}
        onTouchStart={touching}
        onTouchEnd={released}
        onTouchCancel={released}
        onWheel={wheeled}
      >
        {turns === null && !loadError ? (
          <div className="chat" aria-busy="true" aria-label="Загрузка истории">
            <div className="skeleton" style={{ height: 56, width: '70%' }} />
            <div className="skeleton" style={{ height: 56, width: '55%', alignSelf: 'flex-end' }} />
          </div>
        ) : null}

        {loadError ? (
          <div className="sec" role="alert">
            <p style={{ fontWeight: 600 }}>{loadError}</p>
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => void load()}>
              Повторить
            </button>
          </div>
        ) : null}

        {turns ? (
          <div className="chat" aria-live="polite">
            {turns.map((t) => (
              <Message key={t.id} turn={t} onPick={pickQuick} disabled={Boolean(sending)} />
            ))}
            {sending ? (
              <>
                <div className="msg me">{sending.text}</div>
                <div className="msg" aria-label="Агент печатает">
                  <span className="typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {empty && !phone ? (
          <div className="chat-empty">
            <div className="sug" data-tour="suggestions" style={{ justifyContent: 'center' }}>
              {SUGGESTIONS.map((s) => suggestionButton(s))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="composer-wrap">
        {turns !== null && (!empty || phone) ? (
          <>
            <button
              type="button"
              className="sug-handle"
              data-tour="suggestions-handle"
              aria-expanded={suggestionsOpen}
              aria-controls="chat-suggestions"
              onPointerDown={down}
              onMouseDown={down}
              onClick={() => (phone ? setPhoneOpen((v) => !v) : setChipsOpen((v) => !v))}
            >
              Подсказки
              <svg className="sug-chev" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 10 5 5 5-5" />
              </svg>
            </button>
            <div id="chat-suggestions" className="sug-panel" data-open={suggestionsOpen}>
              <div inert={!suggestionsOpen}>
                <div className="sug" data-tour="suggestions">
                  {SUGGESTIONS.map((s) => suggestionButton(s, Boolean(sending)))}
                </div>
              </div>
            </div>
          </>
        ) : null}
        {sendError ? (
          <p className="form-error" role="alert" style={{ paddingTop: 6 }}>
            {sendError}
          </p>
        ) : null}
        <div className="composer" data-tour="chat-input">
          <textarea
            ref={fieldRef}
            rows={1}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={onFieldKeyDown}
            onFocus={() => {
              // На телефоне фокус в поле это открытая клавиатура: подсказки сворачиваются сразу,
              // не дожидаясь, пока вьюпорт успеет измениться
              if (isCoarse()) setKbOpen(true);
            }}
            onBlur={() => setKbOpen(false)}
            placeholder="Например: какая ставка выгоднее?"
            aria-label="Вопрос агенту"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="sentences"
            spellCheck={false}
            enterKeyHint="send"
            maxLength={1000}
          />
          <button
            type="button"
            onPointerDown={down}
            onMouseDown={down}
            onClick={() => press(draft)}
            disabled={!draft.trim() || Boolean(sending)}
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
