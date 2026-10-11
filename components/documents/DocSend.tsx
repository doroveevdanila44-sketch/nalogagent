'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/client/api';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import { DEMO_MAIL_NOTE } from '@/components/provenance/SendToSpecialist';
import { REVIEWER_IDS } from '@/lib/documents/workflow';
import type { Person } from '@/lib/provenance/types';

/**
 * Окно «Отправить бухгалтеру на проверку»: то же, что «Передать специалисту» в расчётах, но
 * получатель только бухгалтер или финансовый директор. Письмо не отправляется (демо): статус
 * документа меняется на «На проверке», получатель и комментарий пишутся в историю.
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
    <Overlay kind="modal" label="Отправить бухгалтеру на проверку" onClose={onClose}>
      <OverlayHead title="Отправить на проверку" sub={DEMO_MAIL_NOTE} onClose={onClose} />
      <div className="ov-scroll">
        <p className="demo-banner" data-testid="demo-mail-note">
          {DEMO_MAIL_NOTE}. Статус документа изменится на «На проверке», получатель ничего не получит.
        </p>
        <div className="send-what">
          <p className="calc-kicker">Документ</p>
          <p className="send-title">{title}</p>
        </div>

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
          <button type="button" className="act" onClick={onClose}>
            Отмена
          </button>
        </div>
        <p className="calc-note">{DEMO_MAIL_NOTE}.</p>
      </div>
    </Overlay>
  );
}
