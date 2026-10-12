'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { downloadFile, errorText } from '@/components/provenance/client';
import { DEMO_MAIL_NOTE } from '@/components/provenance/SendToSpecialist';
import type { DocumentDetail } from '@/lib/documents/detail';
import { missingText } from '@/lib/documents/fill';
import { shortDateTime } from '@/lib/provenance/line';
import { CATEGORY_LABEL, STATUS_LABEL, type EventInfo } from '@/lib/documents/types';
import { DocCheck } from './DocCheck';
import { DocSend } from './DocSend';
import { FillForm } from './FillForm';
import { Legend, Preview } from './Preview';
import { StatusChip } from './StatusChip';

const EVENT_TEXT: Record<string, (e: EventInfo) => string> = {
  created: () => 'Документ создан из шаблона',
  version: (e) => {
    const n = Number(e.data.changes ?? 0);
    return `Новая версия ${e.versionN}: изменений ${n}`;
  },
  submitted: (e) => `Отправлен на проверку: ${String(e.data.recipient ?? '')}`,
  withdrawn: () => 'Документ отозван',
  comment: (e) => `Комментарий: ${String(e.data.text ?? '')}`,
  remark: (e) => `Замечание (демо): ${String(e.data.text ?? '')}`,
  approval: (e) => `Согласовано (демо): ${String(e.data.text ?? '')}`,
  resolved: () => 'Комментарий отмечен решённым',
};

/**
 * Страница документа: предпросмотр с подсветкой, счётчик недостающих полей, действия, версии,
 * комментарии и лента истории. Старую версию можно открыть, править её нельзя.
 */
export function DocumentView({ id }: { id: string }) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [panel, setPanel] = useState<null | 'complete' | 'edit' | 'check' | 'send'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [commentField, setCommentField] = useState<string>('');
  const [commentText, setCommentText] = useState('');

  const load = useCallback(
    async (version: number | null = shown) => {
      setError(null);
      try {
        const d = await api<DocumentDetail>(`/api/documents/${id}${version ? `?version=${version}` : ''}`);
        setDoc(d);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'locked') return;
        setError(errorText(e, 'Не удалось загрузить документ'));
      }
    },
    [id, shown],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const on = () => void load();
    window.addEventListener(UNLOCKED_EVENT, on);
    return () => window.removeEventListener(UNLOCKED_EVENT, on);
  }, [load]);

  const act = useCallback(
    async (name: string, run: () => Promise<void>, ok?: string) => {
      setBusy(name);
      setNotice(null);
      try {
        await run();
        if (ok) setNotice(ok);
        await load(null);
        setShown(null);
      } catch (e) {
        setNotice(errorText(e, 'Действие не выполнено. Повторите.'));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const fieldLabel = useMemo(() => new Map((doc?.fields ?? []).map((f) => [f.key, f.label])), [doc]);

  if (error) {
    return (
      <div className="sec" role="alert">
        <p style={{ fontWeight: 600 }}>{error}</p>
        <div className="acts">
          <button type="button" className="act" onClick={() => void load()}>
            Повторить
          </button>
          <Link className="act" href="/documents">
            К документам
          </Link>
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div role="status" aria-busy="true" aria-label="Загрузка документа">
        <div className="skeleton" style={{ height: 40, marginTop: 18, width: '70%' }} />
        <div className="skeleton" style={{ height: 320, marginTop: 14 }} />
      </div>
    );
  }

  const tz = doc.tz;
  const jump = (key: string) => {
    const el = document.getElementById(`f-${key}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    el.classList.add('df-flash');
    window.setTimeout(() => el.classList.remove('df-flash'), 1600);
  };

  const download = () =>
    act('download', async () => {
      await downloadFile(`/api/documents/${doc.id}/download${doc.shownVersion !== doc.version ? `?version=${doc.shownVersion}` : ''}`);
    });

  const addComment = () =>
    act(
      'comment',
      async () => {
        await api(`/api/documents/${doc.id}/comments`, {
          body: { fieldKey: commentField === '' ? null : commentField, body: commentText },
        });
        setCommentText('');
      },
      'Комментарий добавлен',
    );

  const canSubmit = doc.can.submit && doc.missing.length === 0;
  const unresolved = doc.comments.filter((c) => !c.resolved).length;

  return (
    <div className="doc-page">
      <p className="doc-back">
        <Link href="/documents">К документам</Link>
      </p>
      <header className="doc-head">
        <h1 id="h-doc">{doc.title}</h1>
        <div className="doc-meta">
          <StatusChip status={doc.status} />
          <span className="doc-ver" data-testid="doc-version">
            Версия {doc.shownVersion}
            {doc.readOnly ? ` из ${doc.version}` : ''}
          </span>
        </div>
        {/* юрлицо и период уже в названии документа, здесь только то, чего в названии нет */}
        <p className="doc-sub">
          {CATEGORY_LABEL[doc.category]}
          {doc.reviewer && doc.status !== 'draft' ? ` · проверяет ${doc.reviewer.name}, ${doc.reviewer.role}` : ''}
        </p>
      </header>

      {doc.readOnly ? (
        <p className="calc-warns" role="status" data-testid="readonly-note">
          Это версия {doc.shownVersion}: её править нельзя.{' '}
          <button type="button" className="linkish" onClick={() => { setShown(null); void load(null); }}>
            Открыть нынешнюю версию {doc.version}
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="doc-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="doc-layout">
        <div className="doc-main">
          <section aria-labelledby="h-miss" className="doc-missing" data-testid="missing-box">
            <h2 id="h-miss" data-testid="missing-count">
              {missingText(doc.missing.length)}
            </h2>
            {doc.missing.length > 0 ? (
              <ul aria-label="Недостающие поля">
                {doc.missing.map((k) => (
                  <li key={k}>
                    <button type="button" className="miss-link" data-missing={k} onClick={() => jump(k)}>
                      {fieldLabel.get(k) ?? k}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="acts doc-acts" role="group" aria-label="Действия с документом">
            {doc.can.edit && doc.missing.length > 0 ? (
              <button type="button" className="act primary" data-action="complete" onClick={() => setPanel('complete')}>
                Дозаполнить
              </button>
            ) : null}
            {doc.can.edit ? (
              <button type="button" className="act" data-action="edit" onClick={() => setPanel('edit')}>
                Править
              </button>
            ) : null}
            <button type="button" className="act" data-action="check" onClick={() => setPanel('check')}>
              Проверить самому
            </button>
            <button type="button" className="act" data-action="download" disabled={busy === 'download'} onClick={() => void download()}>
              {busy === 'download' ? 'Готовлю файл…' : `Скачать .${doc.output}`}
            </button>
            {doc.can.submit ? (
              <button
                type="button"
                className="act"
                data-action="submit"
                disabled={!canSubmit}
                aria-describedby={canSubmit ? undefined : 'submit-hint'}
                onClick={() => setPanel('send')}
              >
                Отправить бухгалтеру на проверку
              </button>
            ) : null}
            {doc.can.withdraw ? (
              <button
                type="button"
                className="act"
                data-action="withdraw"
                disabled={busy === 'withdraw'}
                onClick={() => void act('withdraw', () => api(`/api/documents/${doc.id}/withdraw`, { body: {} }).then(() => undefined), 'Документ отозван')}
              >
                Отозвать
              </button>
            ) : null}
          </div>
          {doc.can.submit && !canSubmit ? (
            <p id="submit-hint" className="calc-note">
              Отправить на проверку можно, когда заполнены обязательные поля.
            </p>
          ) : null}
          {doc.status === 'review' && !doc.readOnly ? (
            <p className="calc-note">Документ на проверке: править его нельзя, сначала отзовите.</p>
          ) : null}
          {doc.status === 'approved' && !doc.readOnly ? (
            <p className="calc-note">
              Версия согласована. Правка создаст новую версию и вернёт документ в «Черновик»; согласованная версия
              останется в истории как была.
            </p>
          ) : null}

          {doc.can.simulate ? (
            <section className="demo-reply" aria-labelledby="h-demo" data-testid="demo-reply">
              <h2 id="h-demo">Имитировать ответ бухгалтера</h2>
              <p className="calc-note">
                Настоящего ответа не будет: кнопки добавляют ответ с пометкой «Демо», чтобы пройти весь процесс.
              </p>
              <div className="acts" role="group" aria-label="Имитация ответа">
                {(
                  [
                    ['comment', 'Комментарий'],
                    ['remark', 'Замечание'],
                    ['approve', 'Согласовать'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className="act"
                    data-action={`simulate-${kind}`}
                    disabled={busy === `sim-${kind}`}
                    onClick={() =>
                      void act(
                        `sim-${kind}`,
                        () => api(`/api/documents/${doc.id}/simulate`, { body: { kind } }).then(() => undefined),
                        kind === 'approve' ? 'Демо: документ согласован' : kind === 'remark' ? 'Демо: получено замечание' : 'Демо: получен комментарий',
                      )
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <Legend />

          <article className="doc-paper" aria-label="Предпросмотр документа" data-testid="doc-paper">
            {doc.watermark ? (
              <>
                <div className="doc-watermark" data-testid="watermark" aria-hidden="true">
                  {Array.from({ length: 10 }, (_, i) => (
                    <span key={i}>{doc.watermark}</span>
                  ))}
                </div>
                <p className="doc-draft-note" data-testid="watermark-note">
                  {doc.watermark}
                </p>
              </>
            ) : null}
            <Preview
              blocks={doc.blocks}
              documentId={doc.id}
              version={doc.shownVersion}
              comments={doc.comments}
              sources={doc.sources}
            />
          </article>
        </div>

        <aside className="doc-side" aria-label="Версии, комментарии и история">
          <details className="doc-sec" open>
            <summary>Версии ({doc.versions.length})</summary>
            <ol className="ver-list" data-testid="versions">
              {doc.versions.map((v) => {
                // создание документа есть в «Истории» с той же датой: в версии оно не повторяется
                const changes = v.changes.filter((c) => c.field !== 'created');
                return (
                <li key={v.n} className={v.n === doc.shownVersion ? 'on' : ''}>
                  <div className="ver-head">
                    <b>Версия {v.n}</b>
                    {v.n === doc.version ? <span className="ver-now">нынешняя</span> : null}
                  </div>
                  <small>
                    {v.authorName}, {shortDateTime(Date.parse(v.createdAt), tz)}
                  </small>
                  {changes.length > 0 ? (
                    <ul className="ver-changes">
                      {changes.map((c, i) => (
                        <li key={i}>
                          {c.field === 'calc' ? (
                            c.label
                          ) : (
                            <>
                              {c.label}: {c.from ?? 'пусто'} → {c.to ?? 'пусто'}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <small className="ver-hash" title={v.hash}>
                    контрольная сумма {v.hash.slice(0, 12)}
                  </small>
                  {v.n !== doc.shownVersion ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setShown(v.n === doc.version ? null : v.n);
                        void load(v.n === doc.version ? null : v.n);
                      }}
                    >
                      Открыть версию {v.n}
                    </button>
                  ) : null}
                </li>
                );
              })}
            </ol>
          </details>

          <details className="doc-sec" open>
            <summary>
              Комментарии ({doc.comments.length}
              {unresolved > 0 ? `, без решения: ${unresolved}` : ''})
            </summary>
            <ul className="cm-list" data-testid="comments">
              {doc.comments.map((c) => (
                <li key={c.id} className={`cm cm-${c.kind}${c.resolved ? ' resolved' : ''}`}>
                  <div className="cm-head">
                    <b>{c.authorName}</b>
                    <span className="cm-kind">
                      {c.kind === 'remark' ? 'Замечание' : c.kind === 'approval' ? 'Согласование' : 'Комментарий'}
                      {c.isDemo ? ' · Демо' : ''}
                    </span>
                  </div>
                  <p>{c.body}</p>
                  <small>
                    {shortDateTime(Date.parse(c.createdAt), tz)}, версия {c.versionN}
                    {c.fieldKey ? (
                      <>
                        {' · '}
                        <button type="button" className="linkish" onClick={() => jump(c.fieldKey!)}>
                          {fieldLabel.get(c.fieldKey) ?? 'абзац'}
                        </button>
                      </>
                    ) : null}
                    {c.resolved ? ' · решено' : ''}
                  </small>
                  {c.kind !== 'approval' ? (
                    <button
                      type="button"
                      className="act cm-resolve"
                      data-action="resolve"
                      disabled={busy === `res-${c.id}`}
                      onClick={() =>
                        void act(`res-${c.id}`, () =>
                          api(`/api/documents/${doc.id}/comments`, {
                            method: 'PATCH',
                            body: { commentId: c.id, resolved: !c.resolved },
                          }).then(() => undefined),
                        )
                      }
                    >
                      {c.resolved ? 'Снять отметку «решено»' : 'Отметить решённым'}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <form
              className="cm-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addComment();
              }}
            >
              <label className="fld">
                <span>К чему комментарий</span>
                <select aria-label="К чему комментарий" value={commentField} onChange={(e) => setCommentField(e.target.value)}>
                  <option value="">К документу целиком</option>
                  {doc.fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fld">
                <span>Комментарий</span>
                <textarea
                  aria-label="Комментарий"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="Что нужно проверить или уточнить"
                />
              </label>
              <button type="submit" className="act" data-action="comment" disabled={busy === 'comment' || commentText.trim() === ''}>
                Добавить комментарий
              </button>
            </form>
          </details>

          <details className="doc-sec" open>
            <summary>История ({doc.events.length})</summary>
            <ol className="ev-list" data-testid="events">
              {doc.events.map((e) => (
                <li key={e.id} data-event={e.kind}>
                  <small>{shortDateTime(Date.parse(e.createdAt), tz)}</small>
                  <span>
                    <b>{e.actor}</b>: {(EVENT_TEXT[e.kind] ?? (() => e.kind))(e)}
                    {e.kind === 'version' && e.data.toStatus ? ` · статус: ${STATUS_LABEL[e.data.toStatus as keyof typeof STATUS_LABEL] ?? ''}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </aside>
      </div>

      {panel === 'complete' || panel === 'edit' ? (
        <FillForm
          doc={doc}
          mode={panel === 'complete' ? 'missing' : 'all'}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            setNotice('Сохранено: создана новая версия');
            setShown(null);
            void load(null);
          }}
        />
      ) : null}
      {panel === 'check' ? <DocCheck doc={doc} onClose={() => setPanel(null)} /> : null}
      {panel === 'send' ? (
        <DocSend
          documentId={doc.id}
          title={doc.title}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            setNotice(`${DEMO_MAIL_NOTE}. Документ на проверке`);
            setShown(null);
            void load(null);
          }}
        />
      ) : null}
    </div>
  );
}
