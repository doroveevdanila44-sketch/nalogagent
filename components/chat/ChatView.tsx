'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatTurn } from '@/lib/agent/types';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { Message } from './Message';

const SUGGESTIONS = [
  'Какая ставка выгоднее?',
  'Сколько платить за квартал?',
  'Что с порогами?',
  'Налог на прибыль за год?',
];

type Pending = { key: number; text: string };

/**
 * Вкладка «Агент». История хранится в базе, при заходе подгружаются последние 50.
 * Отправка по Enter, перенос по Shift+Enter. Поле ввода 38 px, закреплено над нижней панелью.
 */
export function ChatView() {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<Pending | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, sending]);

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
              <button key={s} type="button" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={endRef} />

      <div className="composer-wrap" ref={composerRef}>
        <div className="wrap">
          {turns !== null && !empty ? (
            <div className="sug" style={{ paddingTop: 8 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} disabled={Boolean(sending)}>
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
          <form
            className="composer"
            onSubmit={(ev) => {
              ev.preventDefault();
              void send(draft);
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              placeholder="Например: какая ставка выгоднее?"
              aria-label="Вопрос агенту"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={1000}
            />
            <button type="submit" disabled={!draft.trim() || Boolean(sending)}>
              Отправить
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
