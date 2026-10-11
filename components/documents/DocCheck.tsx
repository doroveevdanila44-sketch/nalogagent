'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import type { DocumentDetail } from '@/lib/documents/detail';
import { shortDateTime } from '@/lib/provenance/line';
import type { CheckMark } from '@/lib/provenance/types';
import { CalcActions } from '@/components/provenance/CalcActions';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText, type TargetBody } from '@/components/provenance/client';
import { SOURCE_LABEL } from '@/lib/documents/types';

/**
 * «Проверить самому» для документа: каждое подставленное значение с источником и отметкой
 * «сверил». Отметки сохраняются в таблице checks (кто, что, когда) по ключу «документ и версия».
 */
export function DocCheck({ doc, onClose }: { doc: DocumentDetail; onClose: () => void }) {
  const subject = `doc:${doc.id}:v${doc.shownVersion}`;
  const [marks, setMarks] = useState<Map<string, CheckMark>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ marks: CheckMark[] }>(`/api/checks?subject=${encodeURIComponent(subject)}`)
      .then((r) => alive && setMarks(new Map(r.marks.map((m) => [m.item, m]))))
      .catch((e: unknown) => alive && setError(errorText(e, 'Не удалось загрузить отметки')));
    return () => {
      alive = false;
    };
  }, [subject]);

  const rows = useMemo(
    () =>
      doc.fields.map((f) => ({
        f,
        value: doc.values[f.key],
        missing: !doc.values[f.key]?.value,
      })),
    [doc],
  );
  const filled = rows.filter((r) => !r.missing);
  const done = filled.filter((r) => marks.has(`field:${r.f.key}`)).length;
  const target = (): TargetBody => ({ document: doc.id, version: doc.shownVersion });

  const toggle = async (key: string, checked: boolean, amount: string | null) => {
    const item = `field:${key}`;
    const prev = marks.get(item);
    setMarks((m) => {
      const n = new Map(m);
      if (checked) n.set(item, { item, amount, checkedAt: new Date().toISOString() });
      else n.delete(item);
      return n;
    });
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ mark: CheckMark | null }>('/api/checks', { body: { subject, item, checked, amount } });
      setMarks((m) => {
        const n = new Map(m);
        if (res.mark) n.set(item, res.mark);
        else n.delete(item);
        return n;
      });
    } catch (e) {
      setMarks((m) => {
        const n = new Map(m);
        if (prev) n.set(item, prev);
        else n.delete(item);
        return n;
      });
      setError(errorText(e, 'Не удалось сохранить отметку. Повторите.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay kind="screen" label="Проверить документ самому" onClose={onClose}>
      <OverlayHead title="Проверить самому" sub={`Версия ${doc.shownVersion}, Демо-данные`} onClose={onClose} />
      <div className="ov-scroll">
        <p className="chk-intro">
          Каждое значение документа с источником. Сверьте и отметьте. Отметки сохраняются: кто, что и
          когда. Сверено {done} из {filled.length}.
        </p>
        {doc.missing.length > 0 ? (
          <p className="calc-warns" role="status">
            Не заполнено обязательных полей: {doc.missing.length}. Они в списке ниже без отметки.
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <ol className="chk-list">
          {rows.map(({ f, value, missing }) => {
            const mark = marks.get(`field:${f.key}`);
            return (
              <li key={f.key} className={`chk${mark ? ' done' : ''}${missing ? ' miss' : ''}`} data-check={`field:${f.key}`}>
                <label className="chk-row">
                  <input
                    type="checkbox"
                    checked={Boolean(mark)}
                    disabled={missing || busy}
                    onChange={(e) =>
                      void toggle(f.key, e.target.checked, f.source === 'calc' && f.type === 'money' ? (value?.value ?? null) : null)
                    }
                  />
                  <span className="chk-main">
                    <b>{f.label}</b>
                    <span className="chk-val">{missing ? 'не заполнено' : value?.display}</span>
                    <small>
                      {SOURCE_LABEL[value?.source ?? f.source]}
                      {missing ? '' : `. ${doc.sources[f.key] ?? ''}`}
                    </small>
                  </span>
                </label>
                {f.source === 'calc' && f.type === 'money' && !missing ? (
                  <div className="chk-body">
                    <CalcActions
                      variant="icon"
                      tab={value?.calc?.index ?? 0}
                      label={`Показать расчёт: ${f.label}`}
                      getTarget={target}
                    />
                  </div>
                ) : null}
                {mark ? (
                  <p className="chk-meta">Сверено {shortDateTime(Date.parse(mark.checkedAt), doc.tz)}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </Overlay>
  );
}
