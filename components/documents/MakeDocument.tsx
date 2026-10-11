'use client';

import { useEffect, useState } from 'react';
import type { Period } from '@/lib/calc/period';
import { api } from '@/lib/client/api';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import { CATEGORY_LABEL, SAMPLE_NOTE } from '@/lib/documents/types';
import type { Catalog, TemplateMeta } from './api';
import { StartDocument } from './StartDocument';

export interface DocHint {
  entityIds: string[];
  period: Period | null;
  tax: 'vat' | 'usn' | 'profit' | null;
}

/** Подходит ли шаблон ответу: налог совпадает или шаблон без налога (договор, допсоглашение). */
export function suitable(t: TemplateMeta, hint: DocHint): boolean {
  if (t.taxes.length === 0) return t.scope === 'entity';
  return t.taxes.includes(hint.tax ?? 'vat');
}

/**
 * «Сформировать документ» под ответом агента с расчётом. Показывает подходящие шаблоны; выбор
 * открывает окно «Заполнить» с юрлицом и периодом из вопроса. Суммы в документе те же, что в ответе:
 * они считаются тем же calcTax.
 */
export function MakeDocument({ hint }: { hint: DocHint | null }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<TemplateMeta | null>(null);

  useEffect(() => {
    if (!open || catalog) return;
    let alive = true;
    api<Catalog>('/api/documents/templates')
      .then((c) => alive && setCatalog(c))
      .catch((e: unknown) => alive && setError(errorText(e, 'Не удалось загрузить шаблоны')));
    return () => {
      alive = false;
    };
  }, [open, catalog]);

  if (!hint) return null;
  const single = hint.entityIds.length === 1 ? hint.entityIds[0]! : null;
  const list = (catalog?.templates ?? []).filter((t) => suitable(t, hint));

  return (
    <>
      <div className="acts" role="group" aria-label="Документ по расчёту">
        <button type="button" className="act" data-action="make-document" onClick={() => setOpen(true)}>
          Сформировать документ
        </button>
      </div>
      {open ? (
        <Overlay kind="modal" label="Сформировать документ" onClose={() => setOpen(false)}>
          <OverlayHead title="Сформировать документ" sub={SAMPLE_NOTE} onClose={() => setOpen(false)} />
          <div className="ov-scroll">
            <p className="calc-note">
              Юрлицо и период берутся из вашего вопроса, суммы из того же расчёта, что в ответе.
            </p>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {!catalog && !error ? <div className="skeleton" style={{ height: 96, marginTop: 12 }} aria-busy="true" /> : null}
            <ul className="tpl-pick" aria-label="Подходящие шаблоны">
              {list.map((t) => (
                <li key={t.key}>
                  <button type="button" className="act pick" data-template={t.key} onClick={() => setPick(t)}>
                    <b>{t.title}</b>
                    <small>
                      {CATEGORY_LABEL[t.category]} · .{t.output}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {catalog && list.length === 0 ? <p className="calc-note">Подходящих шаблонов нет.</p> : null}
          </div>
        </Overlay>
      ) : null}
      {pick && catalog ? (
        <StartDocument
          template={pick}
          entities={catalog.entities}
          year={catalog.year}
          month={catalog.month}
          initialEntityId={single}
          initialPeriod={hint.period}
          onClose={() => setPick(null)}
        />
      ) : null}
    </>
  );
}
