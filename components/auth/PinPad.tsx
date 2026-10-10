'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useHydrated } from '@/lib/client/hydrated';

export interface PinResult {
  ok: boolean;
  error?: string;
}

interface Props {
  title: string;
  subtitle?: string;
  /** Вызывается, когда введена четвёртая цифра. При ok: false точки трясутся и очищаются */
  onSubmit: (pin: string) => Promise<PinResult>;
  /** Меняется снаружи, чтобы сбросить введённое (например, при переходе на «Повторите PIN») */
  resetKey?: string | number;
  footer?: ReactNode;
  initialError?: string | null;
}

/**
 * Экран ввода PIN как в банковском приложении: 4 точки и клавиатура 3 на 4.
 * Ввод после четвёртой цифры отправляется сам. Для аппаратной клавиатуры есть скрытое поле:
 * type=password (маска), inputmode=numeric, менеджеры паролей отключены.
 */
export function PinPad({ title, subtitle, onSubmit, resetKey, footer, initialError = null }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const valueRef = useRef('');

  const update = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  useEffect(() => {
    update('');
    setError(initialError);
  }, [resetKey, initialError, update]);

  useEffect(() => {
    // Курсор в скрытое поле только на устройствах с мышью: на телефоне не поднимаем системную клавиатуру
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches) {
      input.current?.focus();
    }
  }, [resetKey]);

  const submit = useCallback(
    async (pin: string) => {
      busyRef.current = true;
      setBusy(true);
      const res = await onSubmit(pin);
      busyRef.current = false;
      setBusy(false);
      if (!res.ok) {
        setError(res.error ?? 'Неверный PIN');
        setShake((n) => n + 1);
        update('');
        if (typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches) {
          input.current?.focus();
        }
      }
    },
    [onSubmit, update],
  );

  const push = useCallback(
    (digit: string) => {
      if (busyRef.current) return;
      const current = valueRef.current;
      if (current.length >= 4) return;
      const next = current + digit;
      setError(null);
      update(next);
      // даём дорисоваться четвёртой точке
      if (next.length === 4) setTimeout(() => void submit(next), 60);
    },
    [submit, update],
  );

  const back = useCallback(() => {
    if (busyRef.current) return;
    setError(null);
    update(valueRef.current.slice(0, -1));
  }, [update]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28, width: '100%' }}>
      <div>
        <h1 className="pin-title">{title}</h1>
        {subtitle ? <p className="pin-sub">{subtitle}</p> : null}
      </div>

      <div
        key={shake}
        className={`dots ${shake > 0 ? 'shake' : ''}`}
        role="img"
        aria-label={`Введено цифр: ${value.length} из 4`}
      >
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < value.length ? 'on' : ''} />
        ))}
      </div>

      <p
        className="form-error"
        role="alert"
        style={{ textAlign: 'center', minHeight: 20, marginTop: -12 }}
      >
        {error}
      </p>

      <input
        ref={input}
        className="sr-only"
        type="password"
        name="pva-pin"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={4}
        aria-label="PIN из 4 цифр"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        value={value}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
          if (busyRef.current) return;
          setError(null);
          update(digits);
          if (digits.length === 4) setTimeout(() => void submit(digits), 60);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.length === 4 && !busyRef.current) void submit(value);
        }}
      />

      <div className="pad" role="group" aria-label="Цифровая клавиатура">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="key" onClick={() => push(d)} disabled={busy || !hydrated}>
            {d}
          </button>
        ))}
        <span aria-hidden="true" />
        <button type="button" className="key" onClick={() => push('0')} disabled={busy || !hydrated}>
          0
        </button>
        <button type="button" className="key plain" onClick={back} disabled={busy || !hydrated} aria-label="Удалить цифру">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7z" />
            <path d="m12.5 9.5 5 5m0-5-5 5" />
          </svg>
        </button>
      </div>

      {footer}
    </div>
  );
}
