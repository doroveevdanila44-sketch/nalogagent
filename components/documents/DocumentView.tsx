'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { isIosDevice } from '@/lib/client/device';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { errorText } from '@/components/provenance/client';
import { momentFromEpoch } from '@/lib/calc/time';
import type { DocumentDetail } from '@/lib/documents/detail';
import { stampShort } from '@/lib/provenance/line';
import { DocCheck } from './DocCheck';
import { DocComments } from './DocComments';
import { DocHistory } from './DocHistory';
import { DocMenu, type MenuItem } from './DocMenu';
import { DocSend } from './DocSend';
import { FileIcon } from './FileIcon';
import { FillForm } from './FillForm';
import { StatusChip } from './StatusChip';
import { Unfilled } from './Unfilled';

type Panel = null | 'complete' | 'edit' | 'check' | 'send' | 'history' | 'comments';

/**
 * Страница документа: карточка файла (значок, имя, «Версия 1 · черновик · обновлён 12.10, 11:54»,
 * кнопки «Открыть» и «Отправить») и под ней строка «Не заполнено: N полей». Текста договора на
 * странице нет: «Открыть» ведёт прямо на файл. Остальные действия в меню «ещё»; версии и
 * комментарии в окнах из меню. Старую версию можно открыть, править её нельзя.
 */
export function DocumentView({ id }: { id: string }) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // iPhone и iPad открывают файл во встроенном просмотре; определяется уже в браузере
  const [ios, setIos] = useState(false);
  const unfilledId = useId();

  useEffect(() => setIos(isIosDevice()), []);

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

  /** Действие с перезагрузкой документа; true, если выполнено */
  const act = useCallback(
    async (name: string, run: () => Promise<void>, ok?: string): Promise<boolean> => {
      setBusy(name);
      setNotice(null);
      try {
        await run();
        if (ok) setNotice(ok);
        await load(null);
        setShown(null);
        return true;
      } catch (e) {
        setNotice(errorText(e, 'Действие не выполнено. Повторите.'));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const labels = useMemo(() => {
    const byKey = new Map((doc?.fields ?? []).map((f) => [f.key, f.label]));
    return (doc?.missing ?? []).map((k) => byKey.get(k) ?? k);
  }, [doc]);

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
        <div className="skeleton" style={{ height: 24, marginTop: 18, width: '40%' }} />
        <div className="skeleton" style={{ height: 150, marginTop: 14 }} />
      </div>
    );
  }

  const currentYear = momentFromEpoch(Date.now(), doc.tz).year;
  const stamp = stampShort(Date.parse(doc.updatedAt), doc.tz, currentYear);
  const unresolved = doc.comments.filter((c) => !c.resolved).length;
  const canSubmit = doc.can.submit && doc.missing.length === 0;

  /** Прямая ссылка на файл показанной версии. inline: для встроенного просмотра на iPhone и iPad */
  const fileHref = (inline: boolean) => {
    const q = new URLSearchParams();
    if (doc.readOnly) q.set('version', String(doc.shownVersion));
    if (inline) q.set('inline', '1');
    const s = q.toString();
    return `/api/documents/${doc.id}/file${s ? `?${s}` : ''}`;
  };

  const withdraw = () =>
    act('withdraw', () => api(`/api/documents/${doc.id}/withdraw`, { body: {} }).then(() => undefined), 'Документ отозван');

  const addComment = (fieldKey: string | null, body: string) =>
    act(
      'comment',
      async () => {
        await api(`/api/documents/${doc.id}/comments`, { body: { fieldKey, body } });
      },
      'Комментарий добавлен',
    );

  const resolveComment = (commentId: number, resolved: boolean) =>
    void act(`res-${commentId}`, () =>
      api(`/api/documents/${doc.id}/comments`, { method: 'PATCH', body: { commentId, resolved } }).then(() => undefined),
    );

  const openVersion = (n: number) => {
    const next = n === doc.version ? null : n;
    setShown(next);
    setPanel(null);
    void load(next);
  };

  const menu: MenuItem[] = [
    ...(doc.can.edit && doc.missing.length > 0
      ? [{ key: 'complete', label: 'Дозаполнить', onSelect: () => setPanel('complete') }]
      : []),
    ...(doc.can.edit ? [{ key: 'edit', label: 'Править', onSelect: () => setPanel('edit') }] : []),
    { key: 'check', label: 'Проверить самому', onSelect: () => setPanel('check') },
    { key: 'history', label: 'История версий', onSelect: () => setPanel('history') },
    { key: 'comments', label: 'Комментарии', badge: unresolved, onSelect: () => setPanel('comments') },
    { key: 'download', label: `Скачать .${doc.output}`, href: fileHref(false), download: true },
  ];

  return (
    <div className="doc-page">
      <p className="doc-back">
        <Link href="/documents">К документам</Link>
      </p>

      {doc.readOnly ? (
        <p className="calc-warns" role="status" data-testid="readonly-note">
          Это версия {doc.shownVersion}: её править нельзя.{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setShown(null);
              void load(null);
            }}
          >
            Открыть нынешнюю версию {doc.version}
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="doc-notice" role="status">
          {notice}
        </p>
      ) : null}

      <section className="file-card" aria-labelledby="h-doc" data-testid="file-card" data-kind={doc.output}>
        <div className="file-top">
          <FileIcon kind={doc.output} />
          <h1 id="h-doc" className="file-name" data-testid="file-name">
            {doc.fileName}
          </h1>
          <p className="file-meta" data-testid="file-meta">
            <span className="file-ver" data-testid="doc-version">
              Версия {doc.shownVersion}
              {doc.readOnly ? ` из ${doc.version}` : ''}
            </span>
            {doc.readOnly ? null : (
              <>
                <span aria-hidden="true">·</span>
                <StatusChip status={doc.status} compact />
              </>
            )}
            <span className="file-sep" aria-hidden="true">
              ·
            </span>
            <span className="file-when">
              {doc.readOnly ? 'создана' : 'обновлён'} {stamp}
            </span>
          </p>
          <DocMenu items={menu} />
        </div>

        <div className="file-acts" role="group" aria-label="Действия с файлом">
          {/* Прямая ссылка на файл, а не страница приложения. Компьютер сохраняет файл и открывает его
              в Word; iPhone и iPad показывают его во встроенном просмотре или передают в Pages и Word. */}
          <a
            className="act primary"
            data-action="open"
            href={fileHref(ios)}
            {...(ios ? { target: '_blank', rel: 'noopener' } : { download: '' })}
          >
            Открыть
          </a>
          {doc.can.submit ? (
            <button
              type="button"
              className="act"
              data-action="submit"
              disabled={!canSubmit}
              aria-describedby={canSubmit ? undefined : unfilledId}
              onClick={() => setPanel('send')}
            >
              Отправить
            </button>
          ) : doc.can.withdraw ? (
            <button type="button" className="act" data-action="withdraw" disabled={busy === 'withdraw'} onClick={() => void withdraw()}>
              Отозвать
            </button>
          ) : null}
        </div>
      </section>

      <Unfilled labels={labels} describes={unfilledId} onFill={doc.can.edit ? () => setPanel('complete') : undefined} />

      {unresolved > 0 ? (
        <p className="line-row">
          <button type="button" className="line-toggle" data-action="open-comments" onClick={() => setPanel('comments')}>
            <span>Комментарии без решения: {unresolved}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 7 5 5-5 5" />
            </svg>
          </button>
        </p>
      ) : null}

      {doc.reviewer && doc.status !== 'draft' && !doc.readOnly ? (
        <p className="doc-hint" data-testid="reviewer">
          Проверяет {doc.reviewer.name}, {doc.reviewer.role}
        </p>
      ) : null}
      {doc.status === 'review' && !doc.readOnly ? (
        <p className="doc-hint">Документ на проверке: править его нельзя, сначала отзовите.</p>
      ) : null}
      {doc.status === 'approved' && !doc.readOnly ? (
        <p className="doc-hint">
          Версия согласована. Правка создаст новую версию и вернёт документ в «Черновик»; согласованная версия остаётся в
          истории как была.
        </p>
      ) : null}

      {doc.can.simulate ? (
        <section className="demo-reply" aria-labelledby="h-demo" data-testid="demo-reply">
          <h2 id="h-demo">Имитировать ответ бухгалтера</h2>
          <p className="calc-note">Демо: ответ добавляется с пометкой «Демо», настоящего ответа не будет.</p>
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
      {panel === 'history' ? <DocHistory doc={doc} onOpenVersion={openVersion} onClose={() => setPanel(null)} /> : null}
      {panel === 'comments' ? (
        <DocComments doc={doc} busy={busy} onAdd={addComment} onResolve={resolveComment} onClose={() => setPanel(null)} />
      ) : null}
      {panel === 'send' ? (
        <DocSend
          documentId={doc.id}
          title={doc.fileName}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            setNotice('Документ на проверке');
            setShown(null);
            void load(null);
          }}
        />
      ) : null}
    </div>
  );
}
