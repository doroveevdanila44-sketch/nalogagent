'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RATE,
  computeLive,
  computeStatic,
  fromPayload,
  momentFromEpoch,
  type Selections,
} from '@/lib/calc';
import { api, ApiError } from '@/lib/client/api';
import { LIVE_HOLD_EVENT, isLiveHeld } from '@/lib/client/live';
import type { DashboardResponse } from '@/lib/provenance/dashboard';
import { SourceLine } from '@/components/provenance/SourceLine';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { EntityCard } from './EntityCard';
import { GroupSummary } from './GroupSummary';
import { RevenueChart } from './RevenueChart';
import { Skeletons } from './Skeletons';
import { Warnings } from './Warnings';

/**
 * Вкладка «Дашборд». Сервер отдаёт вход калькулятора (/api/dashboard), всё остальное, включая
 * живые цифры раз в секунду, считается здесь по тем же функциям lib/calc, без запросов к серверу.
 */
export function DashboardView() {
  const [payload, setPayload] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<DashboardResponse>('/api/dashboard');
      setPayload(data);
      setSelections(data.selections);
      setClockOffset(data.serverNow - Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'locked') return;
      if (e instanceof ApiError && e.code === 'rules_missing') setError(e.message);
      else setError(e instanceof ApiError && e.code === 'network' ? 'Нет связи с сервером' : 'Не удалось загрузить данные');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUnlocked = () => void load();
    window.addEventListener(UNLOCKED_EVENT, onUnlocked);
    return () => window.removeEventListener(UNLOCKED_EVENT, onUnlocked);
  }, [load]);

  // Секундный тик. На скрытой вкладке не считаем; пока открыто окно расчёта, проверки или передачи,
  // цифры стоят: окно показывает расчёт на тот момент, и они совпадают до копейки.
  useEffect(() => {
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !isLiveHeld()) setNowMs(Date.now());
    }, 1000);
    // окно закрылось: цифры обновляются сразу, а не со следующего тика
    const onRelease = () => {
      if (!isLiveHeld() && document.visibilityState === 'visible') setNowMs(Date.now());
    };
    window.addEventListener(LIVE_HOLD_EVENT, onRelease);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(LIVE_HOLD_EVENT, onRelease);
    };
  }, []);

  // Момент, на который показаны цифры: по нему кнопки действий считают расчёт
  const atRef = useRef(0);
  useLayoutEffect(() => {
    atRef.current = (nowMs ?? Date.now()) + clockOffset;
  }, [nowMs, clockOffset]);
  const getAt = useCallback(() => atRef.current || Date.now() + clockOffset, [clockOffset]);

  const input = useMemo(() => {
    if (!payload) return null;
    return { ...fromPayload(payload), selections };
  }, [payload, selections]);

  const moment = useMemo(
    () => (payload && nowMs !== null ? momentFromEpoch(nowMs + clockOffset, payload.tz) : null),
    [payload, nowMs, clockOffset],
  );

  // Статическая часть не зависит от секунд: пересчёт при смене суток и выбора ставки
  const dayKey = moment ? `${moment.year}-${moment.month}-${moment.day}` : '';
  const stat = useMemo(
    () => (input && moment ? computeStatic(input, moment) : null),
    [input, dayKey],
  );
  const live = input && moment && stat ? computeLive(input, moment, stat) : null;

  const choose = useCallback(
    async (entityId: string, rate: number) => {
      const current = selections[entityId] ?? DEFAULT_RATE;
      if (current === rate) return;
      const previous = selections;
      setSelections({ ...selections, [entityId]: rate });
      setNotice(null);
      try {
        await api('/api/rates', { body: { entityId, rate } });
      } catch (e) {
        setSelections(previous);
        if (!(e instanceof ApiError && e.code === 'locked')) setNotice('Не удалось сохранить выбор ставки. Повторите.');
      }
    },
    [selections],
  );

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

  if (!payload || !input || !moment || !stat || !live) return <Skeletons />;

  return (
    <div>
      <GroupSummary
        moment={moment}
        input={input}
        live={live}
        stat={stat}
        lines={payload.provenance.banners}
        year={payload.provenance.year}
        getAt={getAt}
      />
      {notice ? (
        <p role="status" className="form-error" style={{ marginTop: 12 }}>
          {notice}
        </p>
      ) : null}

      <section className="sec" aria-labelledby="h-warn">
        <Warnings warnings={stat.warnings} counter={stat.counter} />
      </section>

      <section className="sec" aria-labelledby="h-chart">
        <RevenueChart columns={stat.columns} entities={input.entities} />
        <SourceLine data={payload.provenance.chart} />
      </section>

      <section className="sec" id="entities" aria-labelledby="h-ents">
        <div className="sec-h">
          <h2 id="h-ents">Юрлица</h2>
          <p>Налог растёт в реальном времени по темпу выручки текущего месяца</p>
        </div>
        <div className="ents">
          {input.entities.map((e) => (
            <EntityCard
              key={e.id}
              entity={e}
              rules={input.ctx.rules}
              live={live.perEntity[e.id]!}
              stat={stat.perEntity[e.id]!}
              lines={payload.provenance.entities[e.id]!}
              year={payload.provenance.year}
              getAt={getAt}
              onChoose={(rate) => void choose(e.id, rate)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
