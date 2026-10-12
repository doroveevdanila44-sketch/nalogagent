'use client';

import Link from 'next/link';
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { errorText } from '@/components/provenance/client';
import type { DocumentDetail } from '@/lib/documents/detail';
import { SheetActionBar } from './ActionBar';
import { DocCheck } from './DocCheck';
import { DocComments } from './DocComments';
import { DocHistory } from './DocHistory';
import { DocMenu, type MenuItem } from './DocMenu';
import { DocSend } from './DocSend';
import { DocsShellContext } from './DocumentsShell';
import { isFieldEditable } from './FieldControl';
import { FieldEditor } from './FieldEditor';
import { FillForm } from './FillForm';
import { GridSheet, TextSheet, type SheetCtx } from './SheetBody';
import { StatusChip } from './StatusChip';

type Panel = null | 'complete' | 'check' | 'send' | 'history' | 'comments';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Подсказка источника значения: наведение мышью, фокус с клавиатуры, долгое нажатие на сенсорном экране. */
function useSourceTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  // Когда указатель (палец или мышь) последний раз нажимал или отпускал поле: фокус, пришедший
  // сразу за нажатием, подсказку не показывает
  const lastPointer = useRef(-Infinity);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.bottom });
  };
  const hide = useCallback(() => {
    clear();
    setTip(null);
  }, []);

  useEffect(() => {
    if (!tip) return;
    const off = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', off, true);
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', off, true);
      window.removeEventListener('pointerdown', off, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [tip, hide]);

  const props = (text: string) => ({
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') show(e.currentTarget, text);
    },
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') hide();
    },
    // с клавиатуры (и программно) по фокусу; нажатие пальцем тоже ставит фокус, но подсказку по
    // нему не показываем: у касания она только по долгому нажатию
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (performance.now() - lastPointer.current < 500) return;
      show(e.currentTarget, text);
    },
    onBlur: hide,
    // долгое нажатие: подсказка появляется через полсекунды, обычное нажатие её не вызывает
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      lastPointer.current = performance.now();
      if (e.pointerType === 'mouse') return;
      const el = e.currentTarget;
      clear();
      timer.current = window.setTimeout(() => show(el, text), 450);
    },
    onPointerUp: () => {
      lastPointer.current = performance.now();
      clear();
    },
    onPointerCancel: clear,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'mouse' && Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clear();
    },
  });
  return { tip, props, hide };
}

/**
 * Страница документа: лист, как документ в Claude и ChatGPT. Тонкая верхняя панель (назад, название,
 * статус и версия одной строкой, меню «ещё»), под ней белый лист с текстом, снизу закреплённая панель
 * действий. Пропущенные поля жёлтые и вводятся по нажатию; значения из реквизитов и расчёта
 * подчёркнуты и несут подсказку источника. Старую версию можно открыть, править её нельзя.
 */
export function DocumentSheet({ id }: { id: string }) {
  const shell = useContext(DocsShellContext);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const counterId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const cursor = useRef(-1);
  const source = useSourceTip();

  // на телефоне лист на весь экран: нижняя панель вкладок прячется (CSS по атрибуту)
  useEffect(() => {
    document.documentElement.dataset.sheet = 'open';
    return () => {
      delete document.documentElement.dataset.sheet;
    };
  }, []);

  const load = useCallback(
    async (version: number | null = shown) => {
      setError(null);
      try {
        const d = await api<DocumentDetail>(`/api/documents/${id}${version ? `?version=${version}` : ''}`);
        setDoc(d);
        cursor.current = -1;
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

  const fieldsByKey = useMemo(() => new Map((doc?.fields ?? []).map((f) => [f.key, f])), [doc]);

  /** Обязательные пропущенные поля в порядке появления в тексте */
  const missingOrder = useCallback((): string[] => {
    const need = new Set(doc?.missing ?? []);
    const out: string[] = [];
    sheetRef.current?.querySelectorAll<HTMLElement>('[data-state="missing"]').forEach((el) => {
      const key = el.dataset.field ?? '';
      if (need.has(key) && !out.includes(key)) out.push(key);
    });
    return out;
  }, [doc]);

  const jump = useCallback((key: string) => {
    const el = sheetRef.current?.querySelector<HTMLElement>(`[data-field="${key}"][data-state="missing"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    el.classList.add('sf-flash');
    window.setTimeout(() => el.classList.remove('sf-flash'), 1600);
  }, []);

  const step = useCallback(
    (dir: 'first' | 1 | -1) => {
      const order = missingOrder();
      if (order.length === 0) return;
      let i: number;
      if (dir === 'first') i = 0;
      else if (cursor.current < 0) i = dir === 1 ? 0 : order.length - 1;
      else i = (cursor.current + dir + order.length) % order.length;
      cursor.current = i;
      jump(order[i]!);
    },
    [missingOrder, jump],
  );

  if (error) {
    return (
      <div className="sec" role="alert">
        <p style={{ fontWeight: 600 }}>{error}</p>
        <div className="acts">
          <button type="button" className="act" onClick={() => void load()}>
            Повторить
          </button>
          <Link className="act ghost" href="/documents">
            К документам
          </Link>
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div role="status" aria-busy="true" aria-label="Загрузка документа">
        <div className="skeleton" style={{ height: 48, marginTop: 14 }} />
        <div className="skeleton" style={{ height: 420, marginTop: 14 }} />
      </div>
    );
  }

  const unresolved = doc.comments.filter((c) => !c.resolved).length;
  const canSubmit = doc.can.submit && doc.missing.length === 0;

  const fileHref = () => {
    const q = doc.readOnly ? `?version=${doc.shownVersion}` : '';
    return `/api/documents/${doc.id}/file${q}`;
  };

  const withdraw = () =>
    void act('withdraw', () => api(`/api/documents/${doc.id}/withdraw`, { body: {} }).then(() => undefined), 'Документ отозван');

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
    { key: 'download', label: `Скачать .${doc.output}`, href: fileHref(), download: true },
    { key: 'check', label: 'Проверить самому', onSelect: () => setPanel('check') },
    { key: 'history', label: 'История версий', onSelect: () => setPanel('history') },
    { key: 'comments', label: 'Комментарии', badge: unresolved, onSelect: () => setPanel('comments') },
  ];

  const ctx: SheetCtx = {
    doc,
    editable: (key) => {
      const f = fieldsByKey.get(key);
      return Boolean(f) && doc.can.edit && isFieldEditable(f!, doc.values[key]);
    },
    onEdit: (key) => {
      source.hide();
      setEditing(key);
    },
    tipProps: source.props,
  };

  return (
    <div className="sheet-page" data-testid="sheet-page" data-kind={doc.output}>
      <header className="sheet-bar">
        <Link className="icon-btn sheet-back" href="/documents" aria-label="К документам" data-action="back" scroll={false}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5 8 12l7 7" />
          </svg>
        </Link>
        <div className="sheet-head">
          <h1 className="sheet-title" data-testid="sheet-title" title={doc.title}>
            {doc.title}
          </h1>
          <p className="sheet-meta" data-testid="sheet-meta">
            <span data-testid="doc-version">
              Версия {doc.shownVersion}
              {doc.readOnly ? ` из ${doc.version}` : ''}
            </span>
            {doc.readOnly ? null : <StatusChip status={doc.status} compact />}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn bar-wide"
          data-action="wide"
          aria-pressed={shell.wide}
          aria-label={shell.wide ? 'Показать рядом с каталогом' : 'На всю ширину'}
          title={shell.wide ? 'Показать рядом с каталогом' : 'На всю ширину'}
          onClick={shell.toggleWide}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {shell.wide ? <path d="M14 5v14M5 8l-1 4 1 4M19 8l1 4-1 4" /> : <path d="M5 5h14v14H5zM14 5v14" />}
          </svg>
        </button>
        <DocMenu items={menu} dot={unresolved > 0} />
      </header>

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
                className="act ghost"
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

      <div className="sheet-desk">
        <article className={`paper${doc.output === 'xlsx' ? ' paper-xlsx' : ''}`} ref={sheetRef} aria-label="Текст документа" data-testid="sheet">
          {doc.output === 'xlsx' ? <GridSheet ctx={ctx} /> : <TextSheet ctx={ctx} />}
        </article>
      </div>

      {doc.readOnly ? null : (
        <SheetActionBar
          missing={doc.missing.length}
          canFill={doc.can.edit}
          canSubmit={canSubmit}
          canSend={doc.can.submit}
          canWithdraw={doc.can.withdraw}
          busy={busy === 'withdraw'}
          counterId={counterId}
          onFirst={() => step('first')}
          onNext={() => step(1)}
          onPrev={() => step(-1)}
          onFill={() => setPanel('complete')}
          onSend={() => setPanel('send')}
          onWithdraw={withdraw}
        />
      )}

      {source.tip ? (
        <div
          role="tooltip"
          className="sheet-tip"
          data-testid="source-tip"
          style={{
            left: Math.min(Math.max(source.tip.x, 150), (typeof window === 'undefined' ? 1024 : window.innerWidth) - 150),
            top: source.tip.y + 8,
          }}
        >
          {source.tip.text}
        </div>
      ) : null}

      {editing ? (
        <FieldEditor
          doc={doc}
          fieldKey={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setShown(null);
            void load(null);
          }}
        />
      ) : null}
      {panel === 'complete' ? (
        <FillForm
          doc={doc}
          mode="missing"
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
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
          title={doc.title}
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
