'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dec } from '@/lib/calc/decimal';
import { rub2 } from '@/lib/calc/format';
import { api } from '@/lib/client/api';
import { buildChecklist, formulasText, type CheckSection } from '@/lib/provenance/checklist';
import { dateTimeWithZone, isoToDots } from '@/lib/provenance/line';
import { subjectOf } from '@/lib/provenance/query';
import type { CheckMark } from '@/lib/provenance/types';
import type { TargetBody } from './client';
import { errorText } from './client';
import { Overlay, OverlayHead } from './Overlay';
import { SourceLine } from './SourceLine';
import { useSnapshots } from './useSnapshots';

/** Буфер обмена: современный API, при отказе запасной путь через скрытое поле. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

function Item({
  section,
  id,
  title,
  hint,
  mark,
  tz,
  disabled,
  onToggle,
  children,
}: {
  section: CheckSection;
  id: string;
  title: string;
  hint: string;
  mark: CheckMark | undefined;
  tz: string;
  disabled: boolean;
  onToggle: (item: string, checked: boolean, amount: string | null) => void;
  children?: React.ReactNode;
}) {
  const item = `${section.index}:${id}`;
  const stale = mark && mark.amount !== null && section.amount !== null && mark.amount !== section.amount;
  return (
    <li className={`chk${mark ? ' done' : ''}`} data-check={item}>
      <label className="chk-row">
        <input
          type="checkbox"
          checked={Boolean(mark)}
          disabled={disabled}
          onChange={(e) => onToggle(item, e.target.checked, section.amount)}
        />
        <span className="chk-main">
          <b>{title}</b>
          <small>{hint}</small>
        </span>
      </label>
      {mark ? (
        <p className="chk-meta">
          Сверено {dateTimeWithZone(Date.parse(mark.checkedAt), tz)}
          {mark.amount !== null ? `, на сумму ${rub2(dec(mark.amount))}` : ''}
          {stale ? '. С тех пор расчёт изменился, сверьте ещё раз.' : ''}
        </p>
      ) : null}
      {children ? <div className="chk-body">{children}</div> : null}
    </li>
  );
}

function Section({
  section,
  marks,
  tz,
  busy,
  onToggle,
}: {
  section: CheckSection;
  marks: Map<string, CheckMark>;
  tz: string;
  busy: boolean;
  onToggle: (item: string, checked: boolean, amount: string | null) => void;
}) {
  const mk = (id: string) => marks.get(`${section.index}:${id}`);
  const common = { section, tz, disabled: busy, onToggle };
  const byId = new Map(section.items.map((i) => [i.id, i]));
  const item = (id: string) => byId.get(id)!;

  return (
    <section className="chk-section" aria-label={section.title}>
      <div className="chk-head">
        <h3>{section.title}</h3>
        <b className="chk-total" data-testid="check-total">
          {section.total ?? 'Не рассчитано'}
        </b>
      </div>
      <SourceLine data={section.line} />

      <h4>Формулы словами</h4>
      <ul className="chk-words">
        {section.words.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>

      <h4>Пошаговая сверка</h4>
      <ol className="chk-list">
        <Item {...common} id="src" title={item('src').title} hint={item('src').hint} mark={mk('src')}>
          {section.entities.map((e) => (
            <details key={e.entityId} className="chk-det">
              <summary>
                {e.name}
                <span>выручка за период {e.revenue ?? 'нет данных'}</span>
              </summary>
              <ul className="kv-list months">
                {e.months.map((m) => (
                  <li key={m.label}>
                    <div className="kv-name">
                      <b>{m.label}</b>
                      <small>{m.basis}</small>
                    </div>
                    <div className="kv-vals">
                      <span>
                        Выручка: <b>{m.revenue}</b>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </Item>

        <Item {...common} id="rules" title={item('rules').title} hint={item('rules').hint} mark={mk('rules')}>
          {section.rules.length === 0 ? (
            <p className="calc-note">Правила на этот период не применялись.</p>
          ) : (
            <ul className="rule-list">
              {section.rules.map((r) => (
                <li key={`${r.key}|${r.from}`}>
                  <div>
                    <b>{r.title}</b>
                    <span className="rule-val">{r.value}</span>
                  </div>
                  <small>
                    {r.norm ? (
                      <a href={r.norm.url} target="_blank" rel="noopener noreferrer">
                        {r.norm.text}
                      </a>
                    ) : (
                      'Норма не указана'
                    )}
                    {` · действует с ${isoToDots(r.from)}`}
                    {r.to ? ` по ${isoToDots(r.to)}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Item>

        {section.entities.map((e) => (
          <Item
            key={e.entityId}
            {...common}
            id={`ent:${e.entityId}`}
            title={item(`ent:${e.entityId}`).title}
            hint={item(`ent:${e.entityId}`).hint}
            mark={mk(`ent:${e.entityId}`)}
          >
            <details className="chk-det">
              <summary>
                Шаги формулы
                <span>итог {e.tax ?? 'нет данных'}</span>
              </summary>
              <ol className="chk-steps">
                {e.steps.map((st) => (
                  <li key={st.id}>
                    <span className="st-id">{st.id}</span>
                    <div>
                      <span className="st-label">{st.label}</span>
                      <span className="st-text">{st.text}</span>
                      <code>{st.formula}</code>
                    </div>
                    <b className="st-res">{st.result}</b>
                  </li>
                ))}
              </ol>
            </details>
          </Item>
        ))}

        <Item {...common} id="total" title={item('total').title} hint={item('total').hint} mark={mk('total')}>
          <p className="chk-sum">
            {section.entities.map((e) => e.tax ?? '0').join(' + ') || '0'} = <b>{section.total ?? 'нет данных'}</b>
          </p>
        </Item>
      </ol>
    </section>
  );
}

/**
 * Экран «Проверить самому»: исходные цифры, формулы словами, ссылка на норму (НК РФ) и пошаговая
 * сверка. Отметки «сверил» сохраняются в базе (таблица checks: кто, что, когда). Кнопки: скопировать
 * формулы и скачать Excel с формулами.
 */
export function CheckSelf({
  target,
  onClose,
  onExcel,
  excelBusy,
}: {
  target: TargetBody;
  onClose: () => void;
  onExcel: (target: TargetBody) => void;
  excelBusy: boolean;
}) {
  const state = useSnapshots(target);
  const snaps = useMemo(() => (state.status === 'ready' ? state.items : []), [state]);
  const sections = useMemo(() => buildChecklist(snaps), [snaps]);
  const subject = useMemo(() => (snaps.length > 0 ? subjectOf(snaps) : ''), [snaps]);
  const tz = snaps[0]?.tz ?? 'Europe/Moscow';

  const [marks, setMarks] = useState<Map<string, CheckMark>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!subject) return;
    let alive = true;
    api<{ marks: CheckMark[] }>(`/api/checks?subject=${encodeURIComponent(subject)}`)
      .then((r) => alive && setMarks(new Map(r.marks.map((m) => [m.item, m]))))
      .catch((e: unknown) => alive && setError(errorText(e, 'Не удалось загрузить отметки')));
    return () => {
      alive = false;
    };
  }, [subject]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const toggle = useCallback(
    async (item: string, checked: boolean, amount: string | null) => {
      // отметка меняется сразу, сервер подтверждает; при ошибке возвращаем прежнее
      let previous: CheckMark | undefined;
      setMarks((prev) => {
        previous = prev.get(item);
        const next = new Map(prev);
        if (checked) next.set(item, { item, amount, checkedAt: new Date().toISOString() });
        else next.delete(item);
        return next;
      });
      setBusy(true);
      setError(null);
      try {
        const res = await api<{ mark: CheckMark | null }>('/api/checks', {
          body: { subject, item, checked, amount },
        });
        setMarks((prev) => {
          const next = new Map(prev);
          if (res.mark) next.set(item, res.mark);
          else next.delete(item);
          return next;
        });
      } catch (e) {
        setMarks((prev) => {
          const next = new Map(prev);
          if (previous) next.set(item, previous);
          else next.delete(item);
          return next;
        });
        setError(errorText(e, 'Не удалось сохранить отметку. Повторите.'));
      } finally {
        setBusy(false);
      }
    },
    [subject],
  );

  const copy = useCallback(async () => {
    const ok = await copyText(formulasText(snaps));
    setCopied(ok ? 'ok' : 'fail');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied('idle'), 3000);
  }, [snaps]);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const done = sections.reduce((n, s) => n + s.items.filter((i) => marks.has(`${s.index}:${i.id}`)).length, 0);

  return (
    <Overlay kind="screen" label="Проверить самому" onClose={onClose}>
      <OverlayHead title="Проверить самому" onClose={onClose} />
      <div className="ov-scroll">
        {state.status === 'loading' ? (
          <div aria-busy="true" aria-label="Загрузка расчёта">
            <div className="skeleton" style={{ height: 28, width: '60%' }} />
            <div className="skeleton" style={{ height: 160, marginTop: 14 }} />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <p className="form-error" role="alert">
            {state.message}
          </p>
        ) : null}

        {sections.length > 0 ? (
          <>
            <p className="chk-intro">
              Пересчитайте расчёт сами и отмечайте, что сверили. Отметки сохраняются: кто, что и когда.
              Отмечено {done} из {total}.
            </p>
            <div className="acts chk-acts" role="group" aria-label="Материалы для сверки">
              <button type="button" className="act" onClick={() => void copy()}>
                Скопировать формулы
              </button>
              <button type="button" className="act" disabled={excelBusy} onClick={() => onExcel(target)}>
                {excelBusy ? 'Готовлю файл…' : 'Скачать Excel с формулами'}
              </button>
            </div>
            <p className="calc-note" role="status" aria-live="polite">
              {copied === 'ok' ? 'Формулы скопированы в буфер обмена.' : copied === 'fail' ? 'Не удалось скопировать: откройте Excel-файл.' : ''}
            </p>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {sections.map((s) => (
              <Section key={s.index} section={s} marks={marks} tz={tz} busy={busy} onToggle={(i, c, a) => void toggle(i, c, a)} />
            ))}
          </>
        ) : null}
      </div>
    </Overlay>
  );
}
