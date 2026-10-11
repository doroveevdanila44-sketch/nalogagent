'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { holdLive } from '@/lib/client/live';
import { CalcDrawer } from './CalcDrawer';
import { CheckSelf } from './CheckSelf';
import { SendToSpecialist } from './SendToSpecialist';
import { downloadExcel, errorText, type TargetBody } from './client';

export type ActionId = 'calc' | 'excel' | 'check' | 'send';

const LABEL: Record<ActionId, string> = {
  calc: 'Показать расчёт',
  excel: 'Выгрузить в Excel',
  check: 'Проверить самому',
  send: 'Передать специалисту',
};

type Layer = { kind: 'calc' | 'check' | 'send'; target: TargetBody };

/** Кнопки без состояния: общий вид набора действий. */
export function ActionBar({
  label,
  tone = 'light',
  hide = [],
  busy,
  onAction,
}: {
  label: string;
  tone?: 'light' | 'dark';
  hide?: ActionId[];
  busy?: ActionId | null;
  onAction: (id: ActionId) => void;
}) {
  const ids = (Object.keys(LABEL) as ActionId[]).filter((id) => !hide.includes(id));
  return (
    <div className={`acts${tone === 'dark' ? ' on-dark' : ''}`} role="group" aria-label={label} data-testid="actions">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className="act"
          data-action={id}
          disabled={busy === id}
          onClick={() => onAction(id)}
        >
          {busy === id ? 'Готовлю файл…' : LABEL[id]}
        </button>
      ))}
    </div>
  );
}

/**
 * Единый набор действий над расчётом: «Показать расчёт», «Выгрузить в Excel», «Проверить самому»,
 * «Передать специалисту». Подключается к баннерам и карточкам дашборда, к ответам чата и, позже,
 * к документам: нужно только сказать, что считать (`getTarget`). Цель берётся в момент нажатия,
 * поэтому панель, файл и проверка получают тот же момент расчёта, что видел пользователь.
 */
export function CalcActions({
  getTarget,
  label,
  tone = 'light',
  hide,
  focus = 'tax',
  variant = 'bar',
  tab = 0,
}: {
  getTarget: () => TargetBody;
  label: string;
  tone?: 'light' | 'dark';
  hide?: ActionId[];
  /** Какая сумма стоит на экране над кнопками: налог расчёта или выручка. Панель выделяет её */
  focus?: 'tax' | 'revenue';
  /** icon: один значок «Показать расчёт» рядом с суммой (в документе), bar: весь набор кнопок */
  variant?: 'bar' | 'icon';
  /** Какой расчёт открыть первым, если их несколько */
  tab?: number;
}) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Живые цифры дашборда встают в момент нажатия и стоят, пока есть открытое окно
  const hold = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (layers.length === 0 && hold.current) {
      hold.current();
      hold.current = null;
    }
  }, [layers.length]);

  useEffect(
    () => () => {
      hold.current?.();
      hold.current = null;
    },
    [],
  );

  const excel = useCallback(async (target: TargetBody) => {
    setBusy('excel');
    setError(null);
    try {
      await downloadExcel(target);
    } catch (e) {
      setError(errorText(e, 'Не удалось выгрузить файл. Повторите.'));
    } finally {
      setBusy(null);
    }
  }, []);

  const push = useCallback((kind: Layer['kind'], target: TargetBody) => {
    setLayers((l) => [...l, { kind, target }]);
  }, []);

  const pop = useCallback(() => setLayers((l) => l.slice(0, -1)), []);

  const onAction = (id: ActionId) => {
    if (id !== 'excel' && !hold.current) hold.current = holdLive();
    const target = getTarget();
    if (id === 'excel') void excel(target);
    else push(id, target);
  };

  return (
    <>
      {variant === 'icon' ? (
        <button type="button" className="calc-ic" data-action="calc" aria-label={label} title={label} onClick={() => onAction('calc')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="3.5" width="14" height="17" rx="2.2" />
            <path d="M8.5 8h7M8.5 12h2M13.5 12h2M8.5 16h2M13.5 16h2" />
          </svg>
        </button>
      ) : (
        <ActionBar label={label} tone={tone} hide={hide} busy={busy} onAction={onAction} />
      )}
      {error ? (
        <p className="acts-error" role="alert">
          {error}
        </p>
      ) : null}
      {layers.map((l, i) => {
        const close = i === layers.length - 1 ? pop : () => setLayers((cur) => cur.filter((_, j) => j !== i));
        if (l.kind === 'calc') {
          return (
            <CalcDrawer
              key={i}
              target={l.target}
              focus={focus}
              initialTab={tab}
              onClose={close}
              footer={
                <ActionBar
                  label="Действия с расчётом"
                  hide={['calc']}
                  busy={busy}
                  onAction={(id) => (id === 'excel' ? void excel(l.target) : push(id as Layer['kind'], l.target))}
                />
              }
            />
          );
        }
        if (l.kind === 'check') {
          return (
            <CheckSelf
              key={i}
              target={l.target}
              onClose={close}
              onExcel={(t) => void excel(t)}
              excelBusy={busy === 'excel'}
            />
          );
        }
        return <SendToSpecialist key={i} target={l.target} onClose={close} />;
      })}
    </>
  );
}
