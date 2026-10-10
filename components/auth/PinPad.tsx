'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Wordmark } from '@/components/Wordmark';
import { useHydrated } from '@/lib/client/hydrated';

export interface PinResult {
  ok: boolean;
  error?: string;
}

interface Props {
  title: string;
  subtitle?: string;
  /** Вызывается, когда введена четвёртая цифра. При ok: false точки трясутся 400 мс и очищаются */
  onSubmit: (pin: string) => Promise<PinResult>;
  /** Меняется снаружи, чтобы сбросить введённое (например, при переходе на «Повторите PIN») */
  resetKey?: string | number;
  initialError?: string | null;
  /**
   * PIN на этом устройстве заблокирован после пяти ошибок. Клавиши неактивны, а слева внизу
   * появляется «Войти по паролю»: без неё выхода из блокировки на этом экране не было бы.
   */
  blocked?: boolean;
  /** Что делает «Войти по паролю» в блокировке. Без обработчика кнопки нет */
  onPassword?: () => void;
  /** «Отмена» справа внизу, пока не введена ни одна цифра. Без обработчика место пустое */
  onCancel?: () => void;
}

const SHAKE_MS = 400;
const PRESS_MS = 180;

/**
 * Экран кода-пароля по образцу iPhone: знак вверху, заголовок на ~18% высоты, четыре точки
 * на ~25%, клавиатура 3 на 4 с ~34%, внизу строка действий. Справа одна кнопка: «Отмена», пока
 * не введено ни одной цифры, затем «Удалить» (стирает ровно одну последнюю цифру). Слева пусто,
 * кроме блокировки PIN: тогда там «Войти по паролю». Высоты в dvh с учётом safe-area. Колонка
 * не шире 360 px.
 *
 * Логика ввода прежняя: четвёртая цифра отправляется сама; с аппаратной клавиатуры работают
 * цифры и Backspace, Enter не нужен. Скрытое поле type=password с inputmode=numeric оставлено
 * для вспомогательных технологий, менеджеры паролей отключены.
 */
export function PinPad({
  title,
  subtitle,
  onSubmit,
  resetKey,
  initialError = null,
  blocked = false,
  onPassword,
  onCancel,
}: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [shaking, setShaking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const hydrated = useHydrated();
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const blockedRef = useRef(blocked);
  const valueRef = useRef('');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );

  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  const update = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  /** Подсветка клавиши держится 180 мс: быстрый тап успевает показать заливку */
  const flash = useCallback(
    (key: string) => {
      setPressed(key);
      later(() => setPressed((cur) => (cur === key ? null : cur)), PRESS_MS);
    },
    [later],
  );

  useEffect(() => {
    update('');
    setError(initialError);
    setShaking(false);
  }, [resetKey, initialError, update]);

  const focusInput = useCallback(() => {
    // Курсор в скрытое поле только на устройствах с мышью: на телефоне не поднимаем системную клавиатуру
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches) {
      input.current?.focus();
    }
  }, []);

  useEffect(() => {
    focusInput();
  }, [resetKey, focusInput]);

  const submit = useCallback(
    async (pin: string) => {
      busyRef.current = true;
      setBusy(true);
      const res = await onSubmit(pin);
      if (res.ok) {
        // верный PIN: экран плавно уходит, пока открывается следующий
        setLeaving(true);
        busyRef.current = false;
        setBusy(false);
        return;
      }
      setError(res.error ?? 'Неверный PIN');
      setShaking(true);
      // точки трясутся 400 мс, затем очищаются
      later(() => {
        update('');
        setShaking(false);
        busyRef.current = false;
        setBusy(false);
        focusInput();
      }, SHAKE_MS);
    },
    [onSubmit, update, later, focusInput],
  );

  const push = useCallback(
    (digit: string) => {
      if (busyRef.current || blockedRef.current) return;
      const current = valueRef.current;
      if (current.length >= 4) return;
      const next = current + digit;
      setError(null);
      update(next);
      // даём дорисоваться четвёртой точке
      if (next.length === 4) later(() => void submit(next), 60);
    },
    [submit, update, later],
  );

  const back = useCallback(() => {
    if (busyRef.current) return;
    setError(null);
    update(valueRef.current.slice(0, -1));
  }, [update]);

  // Клавиши с клавиатуры работают, даже если фокус на кнопке после клика мышью
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === input.current || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      flash(e.key);
      push(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      flash('del');
      back();
    }
  };

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const key = (d: string) => (
    <button
      key={d}
      type="button"
      className={`key ${pressed === d ? 'pressed' : ''}`}
      onPointerDown={() => flash(d)}
      onClick={() => {
        flash(d);
        push(d);
      }}
      disabled={busy || blocked || !hydrated}
    >
      {d}
    </button>
  );

  const hasDigits = value.length > 0;

  return (
    <div className={`pin-screen ${leaving ? 'leaving' : ''}`} onKeyDown={onKeyDown}>
      <div className="pin-mark">
        <Wordmark tone="light" size="small" />
      </div>

      <div className="pin-head">
        <h1 className="pin-title">{title}</h1>
        {subtitle ? <p className="pin-sub">{subtitle}</p> : null}
      </div>

      <div
        className={`pin-dots ${shaking ? 'shake' : ''}`}
        role="img"
        aria-label={`Введено цифр: ${value.length} из 4`}
      >
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < value.length ? 'on' : ''} />
        ))}
      </div>

      <p className="form-error pin-error" role="alert">
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
        disabled={blocked}
        value={value}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, 4);
          if (busyRef.current || blockedRef.current) return;
          setError(null);
          update(next);
          if (next.length === 4) later(() => void submit(next), 60);
        }}
      />

      <div className="pad" role="group" aria-label="Цифровая клавиатура">
        {digits.map(key)}
        <span aria-hidden="true" />
        {key('0')}
        <span aria-hidden="true" />
      </div>

      <div className="pin-actions">
        <span className="pin-action left">
          {blocked && onPassword ? (
            <button type="button" onClick={onPassword} disabled={busy}>
              Войти по паролю
            </button>
          ) : null}
        </span>
        <span className="pin-action right">
          {hasDigits ? (
            <button
              type="button"
              onPointerDown={() => flash('del')}
              onClick={() => {
                flash('del');
                back();
              }}
              disabled={busy || !hydrated}
            >
              Удалить
            </button>
          ) : onCancel ? (
            <button type="button" onClick={onCancel} disabled={busy}>
              Отмена
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
