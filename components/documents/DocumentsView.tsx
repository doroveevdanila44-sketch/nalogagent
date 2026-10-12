'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { errorText } from '@/components/provenance/client';
import { shortDateTime } from '@/lib/provenance/line';
import { CATEGORIES, CATEGORY_LABEL, type DocumentSummary, type TemplateCategory } from '@/lib/documents/types';
import type { Catalog, TemplateMeta } from './api';
import { StartDocument } from './StartDocument';
import { StatusChip } from './StatusChip';

type Tab = 'catalog' | 'mine';

/**
 * Раздел «Документы»: каталог шаблонов (фильтр по категории, поиск) и мои документы со статусом,
 * версией и числом недостающих полей. Без повторов: метки «Демо-данные» и «Образец, проверить
 * юристом» здесь нет (первая в шапке приложения, вторая в колонтитуле самого файла), подпись
 * категории на карточке только когда фильтр «Все», число шаблонов не пишется.
 */
export function DocumentsView() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [start, setStart] = useState<TemplateMeta | null>(null);
  const [tz] = useState('Asia/Kamchatka');

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
      <div className="sec-h" style={{ marginTop: 18 }}>
        <h1 id="h-docs">Документы</h1>
      </div>

      <div className="seg-tabs" role="tablist" aria-label="Раздел документов">
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
          <div className="doc-filters">
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
                  <div className="tpl-head">
                    <h2>{t.title}</h2>
                    {category === 'all' ? <span className="tpl-cat">{CATEGORY_LABEL[t.category]}</span> : null}
                  </div>
                  <p className="tpl-desc">{t.description}</p>
                  <p className="tpl-meta">
                    {t.scope === 'group' ? 'По группе' : 'По юрлицу'}
                    {t.needsPeriod ? ', за период' : ''} · файл .{t.output} · полей: {t.fields}
                  </p>
                  <div className="acts">
                    <button type="button" className="act primary" data-action="fill" onClick={() => setStart(t)}>
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
            <ul className="req-list" aria-label="Мои документы">
              {docs.map((d) => (
                <li key={d.id} className="req" data-testid="doc-item" data-doc={d.id}>
                  <div className="req-head">
                    <h2>
                      <Link href={`/documents/${d.id}`}>{d.title}</Link>
                    </h2>
                    <StatusChip status={d.status} />
                  </div>
                  <p className="req-meta">
                    {CATEGORY_LABEL[d.category]} · версия {d.version} ·{' '}
                    {shortDateTime(Date.parse(d.updatedAt), tz)}
                  </p>
                  <p className="req-meta">
                    {d.missing > 0 ? `Не заполнено полей: ${d.missing}` : 'Обязательные поля заполнены'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

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
