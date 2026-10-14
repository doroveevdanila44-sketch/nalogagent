'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { dec } from '@/lib/calc/decimal';
import { rub2 } from '@/lib/calc/format';
import { api } from '@/lib/client/api';
import { requestTitle } from '@/lib/provenance/query';
import type { Person, ReviewItem } from '@/lib/provenance/types';
import { errorText, type TargetBody } from './client';
import { Overlay, OverlayHead } from './Overlay';
import { SourceLine } from './SourceLine';
import { useSnapshots } from './useSnapshots';
import { dateTimeWithZone, lineFromSnapshots, snapshotTitle } from '@/lib/provenance/line';

export const MAIL_NOTE = 'Письмо не отправляется';

/**
 * Окно «Отправить на проверку». Получатель из справочника, комментарий, «Отправить». Создаётся
 * запись review_requests со снимком расчёта и Excel; письмо никуда не уходит, об этом сказано
 * только здесь, в окне: «Письмо не отправляется».
 */
export function SendToSpecialist({ target, onClose }: { target: TargetBody; onClose: () => void }) {
  const state = useSnapshots(target);
  const snaps = useMemo(() => (state.status === 'ready' ? state.items : []), [state]);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [recipient, setRecipient] = useState<string>('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReviewItem | null>(null);
  const names = useId();

  useEffect(() => {
    let alive = true;
    api<{ people: Person[] }>('/api/reviews')
      .then((r) => {
        if (!alive) return;
        setPeople(r.people);
        setRecipient((cur) => cur || r.people[0]?.id || '');
      })
      .catch((e: unknown) => alive && setError(errorText(e, 'Не удалось загрузить справочник')));
    return () => {
      alive = false;
    };
  }, []);

  const send = async () => {
    if (busy || !recipient) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ request: ReviewItem }>('/api/reviews', {
        body: { target, recipientId: recipient, comment },
      });
      setDone(res.request);
    } catch (e) {
      setError(errorText(e, 'Не удалось создать запрос. Повторите.'));
    } finally {
      setBusy(false);
    }
  };

  const tz = snaps[0]?.tz ?? 'Europe/Moscow';

  return (
    <Overlay kind="modal" label="Отправить на проверку" onClose={onClose}>
      <OverlayHead title="Отправить на проверку" onClose={onClose} />
      <div className="ov-scroll">
        <p className="demo-banner" data-testid="demo-mail-note">
          {MAIL_NOTE}. Запрос сохранится в разделе «Что проверено», получатель ничего не получит.
        </p>

        {done ? (
          <div className="send-done" role="status" data-testid="send-done">
            <h3>Запрос создан</h3>
            <p>
              <b>{done.statusLabel}</b>
            </p>
            <dl className="send-facts">
              <div>
                <dt>Что</dt>
                <dd>{done.title}</dd>
              </div>
              <div>
                <dt>Кому</dt>
                <dd>
                  {done.recipient.name}, {done.recipient.role}
                </dd>
              </div>
              <div>
                <dt>Когда</dt>
                <dd>{dateTimeWithZone(Date.parse(done.createdAt), tz)}</dd>
              </div>
              {done.comment ? (
                <div>
                  <dt>Комментарий</dt>
                  <dd>{done.comment}</dd>
                </div>
              ) : null}
            </dl>
            <p className="calc-note">К запросу приложены снимок расчёта и файл Excel.</p>
            <div className="acts" role="group" aria-label="Что дальше">
              <Link className="act" href="/statuses" prefetch={false} onClick={onClose}>
                Открыть «Что проверено»
              </Link>
              <button type="button" className="act" onClick={onClose}>
                Закрыть
              </button>
            </div>
          </div>
        ) : (
          <>
            {state.status === 'loading' ? (
              <div className="skeleton" style={{ height: 64 }} aria-busy="true" aria-label="Загрузка расчёта" />
            ) : null}
            {state.status === 'error' ? (
              <p className="form-error" role="alert">
                {state.message}
              </p>
            ) : null}
            {snaps.length > 0 ? (
              <div className="send-what">
                <p className="calc-kicker">Что передаётся</p>
                <p className="send-title">{requestTitle(snaps)}</p>
                <ul className="send-totals">
                  {snaps.map((s, i) => (
                    <li key={i}>
                      {/* один расчёт уже назван заголовком выше */}
                      <span>{snaps.length === 1 ? 'Итог' : snapshotTitle(s)}</span>
                      <b>{s.total === null ? 'не рассчитано' : rub2(dec(s.total))}</b>
                    </li>
                  ))}
                </ul>
                <SourceLine data={lineFromSnapshots(snaps)} />
              </div>
            ) : null}

            <fieldset className="send-people">
              <legend>Кому</legend>
              {people === null && !error ? <div className="skeleton" style={{ height: 96 }} aria-busy="true" /> : null}
              {people?.length === 0 ? (
                <p className="calc-note">Справочник получателей пуст: выполните сид базы.</p>
              ) : null}
              {people?.map((p) => (
                <label key={p.id} className={`send-person${recipient === p.id ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name={names}
                    value={p.id}
                    checked={recipient === p.id}
                    onChange={() => setRecipient(p.id)}
                  />
                  <span>
                    <b>{p.role}</b>
                    <small>{p.name}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="send-comment">
              <span>Комментарий</span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Что именно проверить"
              />
            </label>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="acts" role="group" aria-label="Отправка">
              <button
                type="button"
                className="act primary"
                disabled={busy || !recipient || snaps.length === 0}
                onClick={() => void send()}
              >
                {busy ? 'Отправляю…' : 'Отправить'}
              </button>
              <button type="button" className="act" onClick={onClose}>
                Отмена
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
