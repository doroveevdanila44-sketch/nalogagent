'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import type { DocumentDetail } from '@/lib/documents/detail';
import { FieldControl } from './FieldControl';

/**
 * Маленькое окно ввода значения одного поля прямо с листа документа. Сохранение создаёт новую версию
 * (версия неизменяема), как и «Дозаполнить»; значения из расчёта сюда не попадают, их вручную не вводят.
 * Для текстовых пунктов можно запросить предложение формулировки: это только слова, без сумм и дат.
 */
export function FieldEditor({
  doc,
  fieldKey,
  onClose,
  onSaved,
}: {
  doc: DocumentDetail;
  fieldKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const field = doc.fields.find((f) => f.key === fieldKey);
  const [value, setValue] = useState(doc.values[fieldKey]?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  if (!field) return null;

  const current = doc.values[fieldKey]?.value ?? '';
  const message = (e: unknown, fallback: string) =>
    e instanceof ApiError && (e.code === 'field' || e.code === 'stale') ? e.message : errorText(e, fallback);

  const save = async () => {
    if (busy) return;
    if (value.trim() === current) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/documents/${doc.id}/versions`, {
        body: { baseVersion: doc.version, values: { [fieldKey]: value }, refreshCalc: false },
      });
      onSaved();
    } catch (e) {
      setError(message(e, 'Не удалось сохранить. Повторите.'));
      setBusy(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const res = await api<{ suggestions: string[] }>(`/api/documents/${doc.id}/suggest`, { body: { fieldKey } });
      setOptions(res.suggestions);
    } catch (e) {
      setError(errorText(e, 'Не удалось получить предложение'));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <Overlay kind="modal" label={`Значение поля: ${field.label}`} onClose={onClose}>
      <OverlayHead title={field.label} onClose={onClose} />
      <div className="ov-scroll">
        <form
          className="fill-form field-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="fld">
            <label htmlFor="fe-value" className="sr-only">
              {field.label}
            </label>
            <FieldControl field={field} id="fe-value" value={value} onChange={setValue} autoFocus />
            {field.hint ? <small className="fld-hint">{field.hint}</small> : null}
          </div>
          {field.suggest ? (
            <div className="sugg">
              <button type="button" className="act ghost" disabled={suggesting} onClick={() => void suggest()}>
                {suggesting ? 'Подбираю…' : 'Предложить формулировку'}
              </button>
              {options.length > 0 ? (
                <ul className="sugg-list" aria-label="Варианты формулировки">
                  {options.map((t) => (
                    <li key={t}>
                      <button type="button" className="sugg-item" onClick={() => setValue(t)}>
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="acts" role="group" aria-label="Сохранение">
            <button type="submit" className="act" data-action="save-field" disabled={busy}>
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button type="button" className="act ghost" onClick={onClose}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
