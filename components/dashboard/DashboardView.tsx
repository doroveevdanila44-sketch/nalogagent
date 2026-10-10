'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_RATE,
  computeLive,
  computeStatic,
  fromPayload,
  momentFromEpoch,
  type DashboardPayload,
  type Selections,
} from '@/lib/calc';
import { api, ApiError } from '@/lib/client/api';
import { UNLOCKED_EVENT } from '@/components/AppShell';
import { EntityCard } from './EntityCard';
import { GroupBanner } from './GroupBanner';
import { RevenueChart } from './RevenueChart';
import { Skeletons } from './Skeletons';
import { Warnings } from './Warnings';

/**
 * Вкладка «Дашборд». Сервер отдаёт вход калькулятора (/api/dashboard), всё остальное, включая
 * живые цифры раз в секунду, считается здесь по тем же функциям lib/calc, без запросов к серверу.
 */
export function DashboardView() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<DashboardPayload>('/api/dashboard');
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

  // Секундный тик. На скрытой вкладке не считаем.
  useEffect(() => {
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

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
  const live = input && moment ? computeLive(input, moment) : null;

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
      <GroupBanner
        moment={moment}
        entityCount={input.entities.length}
        live={live}
        stat={stat}
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
      </section>

      <section className="sec" aria-labelledby="h-ents">
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
              onChoose={(rate) => void choose(e.id, rate)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
