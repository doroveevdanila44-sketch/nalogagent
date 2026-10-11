'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { dec } from '@/lib/calc/decimal';
import { rub2 } from '@/lib/calc/format';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { DEMO_LABEL, shortDateTime } from '@/lib/provenance/line';
import type { ReviewItem } from '@/lib/provenance/types';
import { downloadFile, errorText } from './client';
import { DEMO_MAIL_NOTE } from './SendToSpecialist';

/**
 * Раздел «Статусы»: история запросов на проверку, переданных специалисту. Записи создаёт кнопка
 * «Передать специалисту» (демо): статус «Отправлено на проверку», письмо не отправляется.
 */
export function StatusesView() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [tz, setTz] = useState('Europe/Moscow');
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ requests: ReviewItem[]; tz: string }>('/api/reviews');
      setItems(res.requests);
      setTz(res.tz);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'locked') return;
      setError(errorText(e, 'Не удалось загрузить историю запросов'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const on = () => void load();
    window.addEventListener(UNLOCKED_EVENT, on);
    return () => window.removeEventListener(UNLOCKED_EVENT, on);
  }, [load]);

  const download = async (id: string) => {
    setBusy(id);
    setFileError(null);
    try {
      await downloadFile(`/api/export?review=${id}`);
    } catch (e) {
      setFileError(errorText(e, 'Не удалось скачать файл. Повторите.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="statuses">
      <div className="sec-h" style={{ marginTop: 18 }}>
        <h1 id="h-statuses">Статусы</h1>
        <p>{DEMO_LABEL}. {DEMO_MAIL_NOTE}</p>
      </div>
      <p className="calc-note">
        Здесь история расчётов, переданных специалисту. Передать расчёт можно кнопкой «Передать
        специалисту» на дашборде и под ответом агента.
      </p>

      {error ? (
        <div className="sec" role="alert">
          <p style={{ fontWeight: 600 }}>{error}</p>
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => void load()}>
            Повторить
          </button>
        </div>
      ) : null}

      {items === null && !error ? (
        <div aria-busy="true" aria-label="Загрузка истории">
          <div className="skeleton" style={{ height: 120, marginTop: 16 }} />
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
        </div>
      ) : null}

      {fileError ? (
        <p className="form-error" role="alert" style={{ marginTop: 12 }}>
          {fileError}
        </p>
      ) : null}

      {items?.length === 0 ? (
        <div className="sec statuses-empty" data-testid="statuses-empty">
          <p style={{ fontWeight: 600 }}>Запросов пока нет</p>
          <p className="calc-note">
            Откройте <Link href="/dashboard">дашборд</Link> или чат с агентом и нажмите «Передать
            специалисту» под расчётом.
          </p>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <ul className="req-list" aria-label="История запросов">
          {items.map((r) => (
            <li key={r.id} className="req" data-testid="review-item" data-review={r.id}>
              <div className="req-head">
                <h2>{r.title}</h2>
                <span className="req-status">{r.statusLabel}</span>
              </div>
              <p className="req-meta">
                {shortDateTime(Date.parse(r.createdAt), tz)} · {r.recipient.name}, {r.recipient.role}
              </p>
              {r.comment ? <p className="req-comment">{r.comment}</p> : null}
              <ul className="req-totals">
                {r.totals.map((t, i) => (
                  <li key={i}>
                    <span>{t.label}</span>
                    <b>{t.total === null ? 'не рассчитано' : rub2(dec(t.total))}</b>
                  </li>
                ))}
              </ul>
              <div className="req-foot">
                <span className="demo-chip">{DEMO_LABEL}</span> <span className="src-text">{DEMO_MAIL_NOTE}</span>
              </div>
              <div className="acts">
                <button type="button" className="act" disabled={busy === r.id} onClick={() => void download(r.id)}>
                  {busy === r.id ? 'Готовлю файл…' : `Скачать ${r.excelName}`}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
