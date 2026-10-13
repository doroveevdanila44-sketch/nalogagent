'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { errorText } from '@/components/provenance/client';
import { shortDateTime } from '@/lib/provenance/line';
import { CATEGORIES, CATEGORY_LABEL, type DocumentSummary, type TemplateCategory } from '@/lib/documents/types';
import type { Catalog, TemplateMeta } from './api';
import { ConfirmDelete, restoreDrafts } from './ConfirmDelete';
import { DocsShellContext } from './DocumentsShell';
import { StartDocument } from './StartDocument';
import { StatusChip } from './StatusChip';

type Tab = 'catalog' | 'mine';

/**
 * Раздел «Документы»: каталог шаблонов (фильтр по категории, поиск) и мои документы со статусом,
 * версией и числом незаполненных полей. Карточка шаблона: название, одна строка описания и кнопка
 * «Заполнить». Без меток «Образец» и «Демо» (первая в колонтитуле файла, вторая в шапке
 * приложения) и без повторов: категория выбрана фильтром над списком, число полей и тип файла
 * видны уже в самом документе.
 */
export function DocumentsView({
  activeId = null,
  compact = false,
}: {
  /** Открытый сейчас документ: подсвечен в списке */
  activeId?: string | null;
  /** Рядом открыт документ: узкая колонка, заголовок второго уровня */
  compact?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [start, setStart] = useState<TemplateMeta | null>(null);
  const [tz] = useState('Asia/Kamchatka');
  const router = useRouter();
  const shell = useContext(DocsShellContext);
  // удаление: окно подтверждения и режим «Выбрать» (несколько черновиков сразу)
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [select, setSelect] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, d] = await Promise.all([
        api<Catalog>('/api/documents/templates'),
        api<{ documents: DocumentSummary[] }>('/api/documents'),
      ]);
      setCatalog(c);
      setDocs(d.documents);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'locked') return;
      setError(errorText(e, 'Не удалось загрузить документы'));
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

  // Открыли или закрыли документ: список обновляется (новая версия, статус). Вкладка не меняется:
  // человек возвращается в то же место, откуда ушёл.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void api<{ documents: DocumentSummary[] }>('/api/documents')
      .then((d) => setDocs(d.documents))
      .catch(() => undefined);
  }, [activeId]);

  // Список перечитывается после «Отменить» в уведомлении и после отзыва
  const lastRefresh = useRef(shell.refresh);
  useEffect(() => {
    if (lastRefresh.current === shell.refresh) return;
    lastRefresh.current = shell.refresh;
    void api<{ documents: DocumentSummary[] }>('/api/documents')
      .then((d) => setDocs(d.documents))
      .catch(() => undefined);
  }, [shell.refresh]);

  const drafts = useMemo(() => (docs ?? []).filter((d) => d.status === 'draft'), [docs]);

  const leaveSelect = () => {
    setSelect(false);
    setPicked(new Set());
  };
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Черновики удалены: список без них, уведомление с «Отменить» на 8 секунд */
  const deleted = (ids: string[]) => {
    setConfirm(null);
    leaveSelect();
    setDocs((cur) => (cur ? cur.filter((d) => !ids.includes(d.id)) : cur));
    if (activeId && ids.includes(activeId)) router.push('/documents', { scroll: false });
    shell.notify(ids.length > 1 ? `Черновики удалены: ${ids.length}` : 'Черновик удалён', () => restoreDrafts(ids));
  };

  const withdraw = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/api/documents/${id}/withdraw`, { body: {} });
      shell.notify('Документ отозван');
      const d = await api<{ documents: DocumentSummary[] }>('/api/documents');
      setDocs(d.documents);
    } catch (e) {
      shell.notify(errorText(e, 'Не удалось отозвать. Повторите.'));
    } finally {
      setBusyId(null);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.templates ?? []).filter(
      (t) =>
        (category === 'all' || t.category === category) &&
        (q === '' || `${t.title} ${t.description}`.toLowerCase().includes(q)),
    );
  }, [catalog, category, query]);

  if (error) {
    return (
      <div className="sec" role="alert">
        <p style={{ fontWeight: 600 }}>{error}</p>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => void load()}>
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="docs">
      {/* Отступ сверху 24 px на телефоне и 32 px на компьютере: заголовок не прилипает к шапке */}
      <div className="sec-h docs-head">
        {compact ? (
          <h2 id="h-docs" className="docs-title">
            Документы
          </h2>
        ) : (
          <h1 id="h-docs" className="docs-title">
            Документы
          </h1>
        )}
      </div>

      <div className="seg-tabs" role="tablist" aria-label="Раздел документов" data-tour="doc-tabs">
        <button
          type="button"
          role="tab"
          id="tab-catalog"
          aria-selected={tab === 'catalog'}
          aria-controls="panel-catalog"
          className={tab === 'catalog' ? 'on' : ''}
          onClick={() => setTab('catalog')}
        >
          Каталог шаблонов
        </button>
        <button
          type="button"
          role="tab"
          id="tab-mine"
          aria-selected={tab === 'mine'}
          aria-controls="panel-mine"
          className={tab === 'mine' ? 'on' : ''}
          onClick={() => setTab('mine')}
        >
          Мои документы{docs ? ` (${docs.length})` : ''}
        </button>
      </div>

      {catalog === null || docs === null ? (
        <div role="status" aria-busy="true" aria-label="Загрузка документов">
          <div className="skeleton" style={{ height: 120, marginTop: 16 }} />
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
        </div>
      ) : null}

      {catalog ? (
        <section id="panel-catalog" role="tabpanel" aria-labelledby="tab-catalog" hidden={tab !== 'catalog'}>
          <div className="doc-filters" data-tour="doc-catalog">
            <label className="fld">
              <input
                aria-label="Поиск по названию"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по названию"
                autoComplete="off"
              />
            </label>
            <div className="chips-row" role="group" aria-label="Категория">
              <button
                type="button"
                className={`filter${category === 'all' ? ' on' : ''}`}
                aria-pressed={category === 'all'}
                onClick={() => setCategory('all')}
              >
                Все
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`filter${category === c ? ' on' : ''}`}
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="statuses-empty sec" data-testid="templates-empty">
              По этому запросу шаблонов нет. Сбросьте фильтр или поиск.
            </p>
          ) : (
            <ul className="tpl-list" aria-label="Шаблоны документов">
              {shown.map((t) => (
                <li key={t.key} className="tpl" data-template={t.key}>
                  <h2>{t.title}</h2>
                  <p className="tpl-desc">{t.description}</p>
                  <div className="acts">
                    <button
                      type="button"
                      className="act primary"
                      data-action="fill"
                      data-tour="doc-fill"
                      onClick={() => setStart(t)}
                    >
                      Заполнить
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {docs ? (
        <section id="panel-mine" role="tabpanel" aria-labelledby="tab-mine" hidden={tab !== 'mine'}>
          {docs.length === 0 ? (
            <div className="statuses-empty sec" data-testid="docs-empty">
              <p style={{ fontWeight: 600 }}>Документов пока нет</p>
              <p className="calc-note">
                Откройте каталог и нажмите «Заполнить» у шаблона, или сформируйте документ из ответа агента.
              </p>
            </div>
          ) : (
            <>
              {drafts.length > 0 ? (
                <div className="sel-bar" role="group" aria-label="Выбор черновиков">
                  {select ? (
                    <>
                      <span className="sel-count" data-testid="sel-count" aria-live="polite">
                        Выбрано: {picked.size}
                      </span>
                      <button
                        type="button"
                        className="act danger"
                        data-action="delete-selected"
                        disabled={picked.size === 0}
                        onClick={() => setConfirm([...picked])}
                      >
                        Удалить выбранные
                      </button>
                      <button type="button" className="act ghost" data-action="select-done" onClick={leaveSelect}>
                        Готово
                      </button>
                    </>
                  ) : (
                    <button type="button" className="act ghost" data-action="select" onClick={() => setSelect(true)}>
                      Выбрать
                    </button>
                  )}
                </div>
              ) : null}
              <ul className="req-list" aria-label="Мои документы">
              {docs.map((d) => (
                <li
                  key={d.id}
                  className={`req${d.id === activeId ? ' on' : ''}`}
                  data-testid="doc-item"
                  data-doc={d.id}
                  data-status={d.status}
                  aria-current={d.id === activeId ? 'true' : undefined}
                >
                  <div className="req-head">
                    {select && d.status === 'draft' ? (
                      <label className="req-pick">
                        <input
                          type="checkbox"
                          aria-label={`Выбрать: ${d.title}`}
                          checked={picked.has(d.id)}
                          onChange={() => toggle(d.id)}
                        />
                      </label>
                    ) : null}
                    <h2>{d.title}</h2>
                    <StatusChip status={d.status} />
                  </div>
                  <p className="req-meta">
                    {CATEGORY_LABEL[d.category]} · версия {d.version} ·{' '}
                    {shortDateTime(Date.parse(d.updatedAt), tz)}
                  </p>
                  <p className="req-meta">
                    {d.missing > 0 ? `Не заполнено полей: ${d.missing}` : 'Обязательные поля заполнены'}
                  </p>
                  {/* Открывает лист документа в приложении, файл не скачивается */}
                  <div className="acts">
                    <Link className="act" data-action="open" href={`/documents/${d.id}`} prefetch={false} scroll={false}>
                      Открыть
                    </Link>
                    {d.status === 'draft' ? (
                      <button
                        type="button"
                        className="act ghost"
                        data-action="delete"
                        onClick={() => setConfirm([d.id])}
                      >
                        Удалить
                      </button>
                    ) : null}
                    {d.status === 'review' ? (
                      <button
                        type="button"
                        className="act ghost"
                        data-action="withdraw"
                        disabled={busyId === d.id}
                        onClick={() => void withdraw(d.id)}
                      >
                        Отозвать
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {confirm ? <ConfirmDelete ids={confirm} onClose={() => setConfirm(null)} onDeleted={deleted} /> : null}
      {start && catalog ? (
        <StartDocument
          template={start}
          entities={catalog.entities}
          year={catalog.year}
          month={catalog.month}
          onClose={() => setStart(null)}
        />
      ) : null}
    </div>
  );
}
