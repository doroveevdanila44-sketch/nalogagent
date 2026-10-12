'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import type { DocumentDetail } from '@/lib/documents/detail';
import { unfilledText } from '@/lib/documents/fill';
import type { TemplateField } from '@/lib/documents/types';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';

/**
 * «Дозаполнить» (только пропущенные поля) и «Править» (все поля, которые вводятся вручную).
 * Сохранение создаёт новую версию документа. Значения из расчёта вручную не вводятся. Для
 * текстовых пунктов можно запросить у провайдера предложение формулировки: это только слова,
 * суммы и даты в предложение не попадают.
 */
export function FillForm({
  doc,
  mode,
  onClose,
  onSaved,
}: {
  doc: DocumentDetail;
  mode: 'missing' | 'all';
  onClose: () => void;
  onSaved: () => void;
}) {
  const editable = (f: TemplateField) => {
    const v = doc.values[f.key];
    if (f.source === 'calc') return false;
    if (f.source === 'entity') return !v?.value || v.source === 'user';
    return true;
  };
  const isMissing = (f: TemplateField) => !doc.values[f.key]?.value;

  const list = useMemo(
    () => doc.fields.filter((f) => editable(f) && (mode === 'all' || isMissing(f))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, mode],
  );
  const blocked = doc.fields.filter((f) => f.source === 'calc' && isMissing(f) && f.required);

  const [input, setInput] = useState<Record<string, string>>(() =>
    Object.fromEntries(list.map((f) => [f.key, doc.values[f.key]?.value ?? ''])),
  );
  const [refresh, setRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [suggesting, setSuggesting] = useState<string | null>(null);

  const changed = Object.fromEntries(
    list.filter((f) => (input[f.key] ?? '') !== (doc.values[f.key]?.value ?? '')).map((f) => [f.key, input[f.key] ?? '']),
  );

  const suggest = async (key: string) => {
    setSuggesting(key);
    setError(null);
    try {
      const res = await api<{ suggestions: string[] }>(`/api/documents/${doc.id}/suggest`, { body: { fieldKey: key } });
      setOptions((o) => ({ ...o, [key]: res.suggestions }));
    } catch (e) {
      setError(errorText(e, 'Не удалось получить предложение'));
    } finally {
      setSuggesting(null);
    }
  };

  const save = async () => {
    if (busy) return;
    if (Object.keys(changed).length === 0 && !refresh) {
      setError('Ничего не изменено: заполните поля или закройте окно');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/documents/${doc.id}/versions`, {
        body: { baseVersion: doc.version, values: changed, refreshCalc: refresh },
      });
      onSaved();
    } catch (e) {
      setError(errorText(e, 'Не удалось сохранить. Повторите.'));
      setBusy(false);
    }
  };

  const control = (f: TemplateField) => {
    const id = `ff-${f.key}`;
    const common = {
      id,
      value: input[f.key] ?? '',
      'aria-required': f.required,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setInput((s) => ({ ...s, [f.key]: e.target.value })),
    };
    if (f.type === 'longtext') return <textarea {...common} rows={4} maxLength={2000} />;
    if (f.type === 'date') return <input {...common} type="date" />;
    if (f.type === 'money') return <input {...common} type="text" inputMode="decimal" placeholder="5000,00" />;
    if (f.type === 'number') return <input {...common} type="text" inputMode="numeric" />;
    return <input {...common} type="text" maxLength={300} />;
  };

  return (
    <Overlay kind="screen" label={mode === 'missing' ? 'Дозаполнить' : 'Править документ'} onClose={onClose}>
      <OverlayHead
        title={mode === 'missing' ? 'Дозаполнить' : 'Править документ'}
        sub={mode === 'missing' ? unfilledText(doc.missing.length) : 'Правка создаст новую версию'}
        onClose={onClose}
      />
      <div className="ov-scroll">
        {list.length === 0 ? (
          <p className="calc-note">Полей для ввода вручную нет: всё подставлено из реквизитов и расчёта.</p>
        ) : null}
        <form
          className="fill-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {list.map((f) => (
            <div className="fld fld-row" key={f.key}>
              <label htmlFor={`ff-${f.key}`}>
                <span>
                  {f.label}
                  {f.required ? <abbr title="обязательное поле"> *</abbr> : <small> (необязательно)</small>}
                </span>
              </label>
              {control(f)}
              {f.hint ? <small className="fld-hint">{f.hint}</small> : null}
              {f.source === 'entity' ? (
                <small className="fld-hint">Нет в реквизитах юрлица: введите вручную, поле станет «введено вручную».</small>
              ) : null}
              {f.suggest ? (
                <div className="sugg">
                  <button type="button" className="act" disabled={suggesting === f.key} onClick={() => void suggest(f.key)}>
                    {suggesting === f.key ? 'Подбираю…' : 'Предложить формулировку'}
                  </button>
                  {options[f.key]?.length ? (
                    <ul className="sugg-list" aria-label={`Варианты: ${f.label}`}>
                      {options[f.key]!.map((t) => (
                        <li key={t}>
                          <button type="button" className="sugg-item" onClick={() => setInput((s) => ({ ...s, [f.key]: t }))}>
                            {t}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <small className="fld-hint">Это только слова: суммы и даты подставляются из расчёта.</small>
                </div>
              ) : null}
            </div>
          ))}

          {blocked.length > 0 ? (
            <div className="calc-warns" role="note">
              <b>Нет данных расчёта:</b> {blocked.map((f) => f.label).join(', ')}. Эти значения берутся только из
              расчёта и вручную не вводятся.
            </div>
          ) : null}

          {mode === 'all' && doc.calcCount > 0 ? (
            <label className="chk-inline">
              <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
              <span>Пересчитать суммы по актуальным данным (версия получит пометку об обновлении расчёта)</span>
            </label>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="acts" role="group" aria-label="Сохранение">
            <button type="submit" className="act primary" data-action="save" disabled={busy}>
              {busy ? 'Сохраняю…' : 'Сохранить как новую версию'}
            </button>
            <button type="button" className="act" onClick={onClose}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
