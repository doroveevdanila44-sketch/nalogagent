'use client';

import { useCallback, useState } from 'react';
import { AUTH } from '@/lib/auth/config';
import { api, ApiError } from '@/lib/client/api';
import { PinPad, type PinResult } from './PinPad';

type Step = 'current' | 'new' | 'confirm' | 'done';
const FORBIDDEN = AUTH.forbiddenPins as readonly string[];

/** «Сменить PIN»: текущий PIN, новый PIN, повтор. Проверка текущего PIN идёт на сервере. */
export function ChangePin({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('current');
  const [current, setCurrent] = useState('');
  const [first, setFirst] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const onCurrent = useCallback(async (pin: string): Promise<PinResult> => {
    setCurrent(pin);
    setNotice(null);
    setStep('new');
    return { ok: true };
  }, []);

  const onNew = useCallback(async (pin: string): Promise<PinResult> => {
    if (FORBIDDEN.includes(pin)) return { ok: false, error: 'Выберите менее очевидный PIN' };
    setFirst(pin);
    setNotice(null);
    setStep('confirm');
    return { ok: true };
  }, []);

  const onConfirm = useCallback(
    async (pin: string): Promise<PinResult> => {
      if (pin !== first) {
        setNotice('PIN не совпал. Придумайте PIN заново');
        setFirst('');
        setStep('new');
        return { ok: true };
      }
      try {
        await api('/api/auth/pin/change', { body: { currentPin: current, newPin: pin } });
        setStep('done');
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 'wrong_pin') {
            setCurrent('');
            setNotice(e.message);
            setStep('current');
            return { ok: true };
          }
          if (e.code === 'pin_blocked') {
            window.location.assign('/login?mode=password');
            return { ok: true };
          }
          return { ok: false, error: e.message };
        }
        return { ok: false, error: 'Не удалось сменить PIN' };
      }
    },
    [current, first],
  );

  return (
    <div
      className={`auth-screen auth-overlay ${step === 'done' ? '' : 'pin-mode'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Смена PIN"
    >
      {step === 'current' && (
        <PinPad
          key="current"
          title="Введите текущий PIN"
          initialError={notice}
          onSubmit={onCurrent}
          onCancel={onClose}
        />
      )}
      {step === 'new' && (
        <PinPad
          key="new"
          title="Новый PIN из 4 цифр"
          initialError={notice}
          onSubmit={onNew}
          onCancel={onClose}
        />
      )}
      {step === 'confirm' && (
        <PinPad
          key="confirm"
          title="Повторите новый PIN"
          onSubmit={onConfirm}
          onCancel={() => {
            setFirst('');
            setNotice(null);
            setStep('new');
          }}
        />
      )}
      {step === 'done' && (
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
          <h1 className="pin-title">PIN изменён</h1>
          <button type="button" className="btn" onClick={onClose}>
            Готово
          </button>
        </div>
      )}
    </div>
  );
}
