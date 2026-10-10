'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ChatTurn } from '@/lib/agent/types';
import { api, ApiError } from '@/lib/client/api';
import { KEYBOARD_EVENT } from '@/lib/client/keyboard';
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

/** Нажатие на кнопку не отбирает фокус у поля: экранная клавиатура остаётся открытой */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * Вкладка «Агент». История хранится в базе, при заходе подгружаются последние 50.
 * Поле ввода как в приложении Claude: textarea растёт от 38 px до шести строк, дальше внутренняя
 * прокрутка. На компьютере Enter отправляет, Shift+Enter переносит строку; на телефоне Enter
 * переносит строку, отправка только кнопкой. Без родительского form и без других полей ввода на
 * экране: так Safari не рисует над клавиатурой стрелки «вверх, вниз» (см. DECISIONS.md).
 */
export function ChatView() {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<Pending | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const hadFocus = useRef(false);
  const [composerH, setComposerH] = useState(120);

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

  /**
   * Прокрутка в самый низ страницы. Под последним сообщением лежит запас на высоту поля ввода, поэтому
   * на крайней позиции сообщение стоит прямо над полем. scrollIntoView по якорю выровнял бы по низу
   * окна сам якорь, и сообщение ушло бы под поле.
   */
  const scrollToEnd = useCallback(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, []);

  // Последнее сообщение остаётся видно: при новых сообщениях, росте поля и подсказок
  useEffect(() => {
    scrollToEnd();
  }, [turns, sending, composerH, scrollToEnd]);

  // ...и при открытии клавиатуры и любом изменении вьюпорта, пока она открыта
  useEffect(() => {
    window.addEventListener(KEYBOARD_EVENT, scrollToEnd);
    return () => window.removeEventListener(KEYBOARD_EVENT, scrollToEnd);
  }, [scrollToEnd]);

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

  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      setSendError(null);
      setDraft('');
      setSending({ key: Date.now(), text });
      try {
        const res = await api<{ user: ChatTurn; agent: ChatTurn }>('/api/chat', { body: { message: text } });
        setTurns((prev) => [...(prev ?? []), res.user, res.agent]);
      } catch (e) {
        setDraft(text);
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

  const empty = turns !== null && turns.length === 0 && !sending;

  /** Кнопки под полем: если поле было в фокусе, оно остаётся в нём и клавиатура не закрывается */
  const rememberFocus = () => {
    hadFocus.current = document.activeElement === fieldRef.current;
  };
  const press = (text: string) => {
    void send(text);
    if (hadFocus.current) fieldRef.current?.focus();
    hadFocus.current = false;
  };

  const onFieldKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    // На телефоне Enter переносит строку: отправляет только кнопка
    if (window.matchMedia('(pointer: coarse)').matches) return;
    e.preventDefault();
    void send(draft);
  };

  return (
    <div style={{ paddingBottom: composerH }}>
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
            <Message key={t.id} turn={t} />
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

      {empty ? (
        <div
          style={{
            minHeight: '45vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="sug" style={{ justifyContent: 'center' }}>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onPointerDown={rememberFocus}
                onMouseDown={keepFocus}
                onClick={() => press(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="composer-wrap" ref={composerRef}>
        <div className="wrap">
          {turns !== null && !empty ? (
            <div className="sug" style={{ paddingTop: 8 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onPointerDown={rememberFocus}
                  onMouseDown={keepFocus}
                  onClick={() => press(s)}
                  disabled={Boolean(sending)}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          {sendError ? (
            <p className="form-error" role="alert" style={{ paddingTop: 6 }}>
              {sendError}
            </p>
          ) : null}
          <div className="composer">
            <textarea
              ref={fieldRef}
              rows={1}
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={onFieldKeyDown}
              onFocus={scrollToEnd}
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
              onPointerDown={rememberFocus}
              onMouseDown={keepFocus}
              onClick={() => press(draft)}
              disabled={!draft.trim() || Boolean(sending)}
            >
              Отправить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
