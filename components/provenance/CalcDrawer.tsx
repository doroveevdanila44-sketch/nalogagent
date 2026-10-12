'use client';

import { useState } from 'react';
import { dec } from '@/lib/calc/decimal';
import { dateRuYear, rub2 } from '@/lib/calc/format';
import { formatLoadedAt } from '@/lib/calc/provenance';
import { KIND_LABEL, preciseDateTime, snapshotTitle } from '@/lib/provenance/line';
import { normLink, RULE_TITLE } from '@/lib/provenance/norms';
import type { CalcSnapshot } from '@/lib/provenance/snapshot';
import type { TargetBody } from './client';
import { Overlay, OverlayHead } from './Overlay';
import { useSnapshots } from './useSnapshots';

const money = (v: string | null) => (v === null ? 'нет данных' : rub2(dec(v)));

function isoRu(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return dateRuYear({ year: y, month: m - 1, day: d });
}

function ruleValue(r: CalcSnapshot['rules'][number]): string {
  if (r.value === null) return r.formula ?? 'не утверждено';
  const n = r.value.replace(/\.0+$/, '');
  if (r.unit === 'percent') return `${n}%`;
  if (r.unit === 'rub') return rub2(dec(r.value));
  return n;
}

function Result({ s, focus }: { s: CalcSnapshot; focus: 'tax' | 'revenue' }) {
  const multi = s.entities.filter((e) => e.applicable);
  const skipped = s.entities.filter((e) => !e.applicable);
  const shownWarnings = s.warnings.filter((w) => w.kind !== 'not_applicable' && w.kind !== 'rate_fixed');
  const assumptions = s.assumptions ?? [];
  // что именно показано на экране под кнопкой: выручка или налог
  const headline = focus === 'revenue' ? s.revenue : s.total;
  const second = focus === 'revenue' ? s.total : s.revenue;

  return (
    <div className="calc-body">
      <p className="calc-kicker">
        {focus === 'revenue' ? `Выручка с НДС, ${s.periodLabel}` : snapshotTitle(s)}
      </p>
      <p className="calc-total" data-testid="calc-total" data-amount={headline ?? ''}>
        {headline === null ? 'Не рассчитано' : rub2(dec(headline))}
      </p>
      <p className="calc-second" data-testid="calc-second">
        {focus === 'revenue' ? `${s.taxName} за период` : 'Выручка с НДС за период'}:{' '}
        <b>{second === null ? 'нет данных' : rub2(dec(second))}</b>
      </p>
      {/* источник и основа названы ниже в разделе «Источник»: отдельная строка наверху их повторяла бы */}
      <p className="calc-at">
        Расчёт на {preciseDateTime(s.at, s.tz)}. Цифры те же, что на экране в этот момент.
      </p>
      {assumptions.length > 0 ? (
        <section className="calc-sec" aria-labelledby={`c-asm-${s.tax}`} data-testid="calc-assumptions">
          <h3 id={`c-asm-${s.tax}`}>Допущения</h3>
          <ul className="calc-warns">
            {assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {shownWarnings.length > 0 ? (
        <ul className="calc-warns">
          {shownWarnings.map((w, i) => (
            <li key={i}>{w.text}</li>
          ))}
        </ul>
      ) : null}

      <section className="calc-sec" aria-labelledby={`c-ent-${s.tax}`}>
        <h3 id={`c-ent-${s.tax}`}>Итог по юрлицам</h3>
        <ul className="kv-list">
          {multi.map((e) => (
            <li key={e.entityId} data-entity={e.entityId}>
              <div className="kv-name">
                <b>{e.name}</b>
                <small>
                  {e.rate !== null ? `ставка НДС ${e.rate}%, ` : ''}
                  {KIND_LABEL[e.kind]}
                </small>
              </div>
              <div className="kv-vals">
                <span>
                  Выручка: <b data-field="revenue">{money(e.revenue)}</b>
                </span>
                <span>
                  {s.taxName}: <b data-field="tax">{money(e.tax)}</b>
                </span>
              </div>
            </li>
          ))}
        </ul>
        {skipped.length > 0 ? (
          <p className="calc-note">
            Не входят в итог: {skipped.map((e) => e.name).join(', ')} (этот налог для их режима не считается).
          </p>
        ) : null}
      </section>

      <section className="calc-sec" aria-labelledby={`c-steps-${s.tax}`}>
        <h3 id={`c-steps-${s.tax}`}>Шаги формулы</h3>
        <p className="calc-note">
          Каждая цифра получена шагом: у шага есть формула с подставленными числами и результат.
        </p>
        {multi.map((e, i) => {
          const steps = s.steps.filter((st) => st.entityId === e.entityId);
          return (
            <details key={e.entityId} className="calc-steps" open={multi.length === 1 || i === 0}>
              <summary>
                {e.name}
                <span>{steps.length} шагов</span>
              </summary>
              <ol>
                {steps.map((st) => (
                  <li key={st.id}>
                    <span className="st-id">{st.id}</span>
                    <div>
                      <span className="st-label">{st.label}</span>
                      <span className="st-text">{st.text}</span>
                    </div>
                    <b className="st-res">{rub2(dec(st.result))}</b>
                  </li>
                ))}
              </ol>
            </details>
          );
        })}
        {s.totalStep ? (
          <p className="calc-final">
            {(() => {
              const st = s.steps.find((x) => x.id === s.totalStep);
              return st ? `${st.id}: ${st.text}` : '';
            })()}
          </p>
        ) : null}
      </section>

      <section className="calc-sec" aria-labelledby={`c-rules-${s.tax}`}>
        <h3 id={`c-rules-${s.tax}`}>Применённые правила</h3>
        {s.rules.length === 0 ? (
          <p className="calc-note">Правила на этот период не применялись.</p>
        ) : (
          <ul className="rule-list">
            {s.rules.map((r) => {
              const link = normLink(r.norm, r.sourceUrl);
              return (
                <li key={`${r.key}|${r.validFrom}`}>
                  <div>
                    <b>{RULE_TITLE[r.key] ?? r.key}</b>
                    <span className="rule-val">{ruleValue(r)}</span>
                  </div>
                  <small>
                    {link ? (
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.text}
                      </a>
                    ) : (
                      'Норма не указана'
                    )}
                    {` · действует с ${isoRu(r.validFrom)}`}
                    {r.validTo ? ` по ${isoRu(r.validTo)}` : ''}
                  </small>
                  {r.note ? <small>{r.note}</small> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="calc-sec" aria-labelledby={`c-src-${s.tax}`}>
        <h3 id={`c-src-${s.tax}`}>Источник</h3>
        <p className="calc-src">
          {s.source ? (
            <>
              {s.source.title}, загружена {formatLoadedAt(s.source.loadedAt, s.tz)}
            </>
          ) : (
            'Источник не указан.'
          )}
        </p>
        <p className="calc-note">
          Основа: {KIND_LABEL[s.kind]}. Прошедшие месяцы берутся из выгрузки, остальные по прогнозу года и
          весам сезонности.
        </p>
      </section>

      <section className="calc-sec" aria-labelledby={`c-mon-${s.tax}`}>
        <h3 id={`c-mon-${s.tax}`}>Разбивка по месяцам</h3>
        <ul className="kv-list months">
          {s.months.map((m) => (
            <li key={m.key} data-month={m.key}>
              <div className="kv-name">
                <b>{m.label}</b>
                <small>{m.status === 'fact' ? 'факт' : m.status === 'partial' ? 'месяц идёт' : 'прогноз'}</small>
              </div>
              <div className="kv-vals">
                <span>
                  Выручка: <b>{money(m.revenue)}</b>
                </span>
                <span>
                  {s.taxName}: <b>{money(m.tax)}</b>
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="calc-note">
          Месяцы хранятся точно, показаны с копейками; итог за период округляется один раз, поэтому сумма
          показанных месяцев может отличаться от итога на копейки.
        </p>
      </section>
    </div>
  );
}

/**
 * Панель «Показать расчёт»: шаги формулы, применённые правила с нормой и датой, источник и разбивка
 * по месяцам. Справа на компьютере, нижним листом на телефоне. Все числа из CalcResult (снимок).
 */
export function CalcDrawer({
  target,
  focus = 'tax',
  initialTab = 0,
  onClose,
  footer,
}: {
  target: TargetBody;
  /** С какого расчёта начать, если их несколько */
  initialTab?: number;
  /** Что показано на экране под кнопкой: налог расчёта или выручка (баннер «Выручка с начала года») */
  focus?: 'tax' | 'revenue';
  onClose: () => void;
  footer: React.ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState(initialTab);
  const state = useSnapshots(target, attempt);
  const items = state.status === 'ready' ? state.items : [];
  const current = items[Math.min(tab, Math.max(items.length - 1, 0))];

  return (
    <Overlay kind="drawer" label="Расчёт" onClose={onClose}>
      <OverlayHead title="Расчёт" onClose={onClose} />
      <div className="ov-scroll">
        {state.status === 'loading' ? (
          <div aria-busy="true" aria-label="Загрузка расчёта">
            <div className="skeleton" style={{ height: 28, width: '60%' }} />
            <div className="skeleton" style={{ height: 120, marginTop: 14 }} />
            <div className="skeleton" style={{ height: 120, marginTop: 14 }} />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div role="alert">
            <p className="form-error">{state.message}</p>
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          </div>
        ) : null}
        {items.length > 1 ? (
          <div className="calc-tabs" role="tablist" aria-label="Расчёты" data-tour="tax-switch">
            {items.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === tab}
                className={`calc-tab${i === tab ? ' on' : ''}`}
                onClick={() => setTab(i)}
              >
                {snapshotTitle(s)}
              </button>
            ))}
          </div>
        ) : null}
        {current ? <Result s={current} focus={focus} /> : null}
      </div>
      <div className="ov-foot">{footer}</div>
    </Overlay>
  );
}
