'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/client/api';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import { REVIEWER_IDS } from '@/lib/documents/workflow';
import type { Person } from '@/lib/provenance/types';

/**
 * Окно «Отправить»: получатель (бухгалтер или финансовый директор), комментарий и кнопка. Письмо
 * не отправляется: статус документа меняется на «На проверке», получатель и комментарий
 * пишутся в историю. Подпись «Письмо не отправляется» одна и только здесь.
 */
export function DocSend({
  documentId,
  title,
  onClose,
  onDone,
}: {
  documentId: string;
  title: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [recipient, setRecipient] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useId();

  useEffect(() => {
    let alive = true;
    api<{ people: Person[] }>('/api/reviews')
      .then((r) => {
        if (!alive) return;
        const list = r.people.filter((p) => (REVIEWER_IDS as readonly string[]).includes(p.id));
        setPeople(list);
        setRecipient(list[0]?.id ?? '');
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
      await api(`/api/documents/${documentId}/submit`, { body: { recipientId: recipient, comment } });
      onDone();
    } catch (e) {
      setError(errorText(e, 'Не удалось отправить. Повторите.'));
      setBusy(false);
    }
  };

  return (
    <Overlay kind="modal" label="Отправить на проверку" onClose={onClose}>
      <OverlayHead title="Отправить на проверку" sub={title} onClose={onClose} />
      <div className="ov-scroll">
        <fieldset className="send-people">
          <legend>Кому</legend>
          {people === null && !error ? <div className="skeleton" style={{ height: 96 }} aria-busy="true" /> : null}
          {people?.map((p) => (
            <label key={p.id} className={`send-person${recipient === p.id ? ' on' : ''}`}>
              <input type="radio" name={group} value={p.id} checked={recipient === p.id} onChange={() => setRecipient(p.id)} />
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
          <button type="button" className="act primary" data-action="send-confirm" disabled={busy || !recipient} onClick={() => void send()}>
            {busy ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
        <p className="send-demo" data-testid="demo-mail-note">
          Письмо не отправляется
        </p>
      </div>
    </Overlay>
  );
}
