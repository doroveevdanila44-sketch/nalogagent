'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { Period } from '@/lib/calc/period';
import { api } from '@/lib/client/api';
import { MONTH_NAMES } from '@/lib/calc/period';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import { PERIOD_KIND_LABEL, buildPeriod, type EntityOption, type PeriodKind, type TemplateMeta } from './api';

/**
 * Окно «Заполнить»: выбор юрлица и периода (если шаблон про период). Подстановка выполняется на
 * сервере: реквизиты из справочника юрлица, суммы и ставки только из calcTax.
 */
export function StartDocument({
  template,
  entities,
  year,
  month,
  initialEntityId = null,
  initialPeriod = null,
  onClose,
}: {
  template: TemplateMeta;
  entities: EntityOption[];
  /** Нынешний год и месяц (1..12) в поясе приложения */
  year: number;
  month: number;
  initialEntityId?: string | null;
  initialPeriod?: Period | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [entityId, setEntityId] = useState<string>(initialEntityId ?? entities[0]?.id ?? '');
  const seed = initialPeriod;
  const [kind, setKind] = useState<PeriodKind>(
    seed && seed.kind !== 'range' ? seed.kind : template.needsPeriod ? 'quarter' : 'ytd',
  );
  const [py, setPy] = useState<number>(seed && 'year' in seed ? seed.year : year);
  const [pm, setPm] = useState<number>(seed && seed.kind === 'month' ? seed.month : Math.max(1, month - 1));
  const [pq, setPq] = useState<number>(
    seed && seed.kind === 'quarter' ? seed.quarter : Math.max(1, Math.ceil((month - 1) / 3)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const years = useMemo(() => [year, year - 1], [year]);
  const period = buildPeriod(kind, py, pm, pq);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: string }>('/api/documents', {
        body: {
          templateKey: template.key,
          entityId: template.scope === 'entity' ? entityId : null,
          period: template.needsPeriod ? period : null,
        },
      });
      onClose();
      // прокруткой управляет раздел «Документы» (DocumentsShell): лист открывается с начала
      router.push(`/documents/${res.id}`, { scroll: false });
    } catch (e) {
      setError(errorText(e, 'Не удалось создать документ. Повторите.'));
      setBusy(false);
    }
  };

  return (
    <Overlay kind="modal" label={`Заполнить: ${template.title}`} onClose={onClose}>
      <OverlayHead title="Заполнить" onClose={onClose} />
      <div className="ov-scroll">
        <p className="send-title">{template.title}</p>
        <p className="calc-note">
          Реквизиты подставятся из справочника юрлица, суммы и ставки из расчёта. Что не нашлось, будет
          подсвечено в документе.
        </p>

        {template.scope === 'entity' ? (
          <label className="fld">
            <span>Юрлицо</span>
            <select aria-label="Юрлицо" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="calc-note">Документ по всей группе: юрлицо выбирать не нужно.</p>
        )}

        {template.needsPeriod ? (
          <fieldset className="fld-set">
            <legend>Период</legend>
            <label className="fld">
              <span>Вид периода</span>
              <select aria-label="Вид периода" value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}>
                {(Object.keys(PERIOD_KIND_LABEL) as PeriodKind[]).map((k) => (
                  <option key={k} value={k}>
                    {PERIOD_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            {kind !== 'ytd' ? (
              <label className="fld">
                <span>Год</span>
                <select aria-label="Год" value={py} onChange={(e) => setPy(Number(e.target.value))}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {kind === 'month' ? (
              <label className="fld">
                <span>Месяц</span>
                <select aria-label="Месяц" value={pm} onChange={(e) => setPm(Number(e.target.value))}>
                  {MONTH_NAMES.map((n, i) => (
                    <option key={n} value={i + 1}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {kind === 'quarter' ? (
              <label className="fld">
                <span>Квартал</span>
                <select aria-label="Квартал" value={pq} onChange={(e) => setPq(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>
                      {q} квартал
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="acts" role="group" aria-label="Создание документа">
          <button
            type="button"
            className="act primary"
            data-action="create"
            disabled={busy || (template.scope === 'entity' && !entityId)}
            onClick={() => void submit()}
          >
            {busy ? 'Заполняю…' : 'Заполнить'}
          </button>
          <button type="button" className="act" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </Overlay>
  );
}
