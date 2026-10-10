'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { AUTH } from '@/lib/auth/config';
import { api, ApiError, setCsrf } from '@/lib/client/api';
import { Wordmark } from '@/components/Wordmark';
import { useHydrated } from '@/lib/client/hydrated';
import { PinPad, type PinResult } from './PinPad';

type Step = 'password' | 'pin' | 'setup' | 'confirm';
type Initial = 'anonymous' | 'locked' | 'needPinSetup';

const FORBIDDEN = AUTH.forbiddenPins as readonly string[];

/**
 * Сценарии 1 и 2 из AUTH.md: пароль, затем создание PIN (дважды) либо ввод PIN.
 * Пароль живёт только в поле формы и в теле одного POST, в состояние React и в URL не попадает.
 */
export function LoginFlow({ initial, next, notice }: { initial: Initial; next: string; notice?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(
    initial === 'locked' ? 'pin' : initial === 'needPinSetup' ? 'setup' : 'password',
  );
  const [firstPin, setFirstPin] = useState('');
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(notice ?? null);

  const done = useCallback(() => {
    router.replace(next);
    router.refresh();
  }, [router, next]);

  const goPassword = useCallback((message: string | null) => {
    setPasswordNotice(message);
    setFirstPin('');
    setStep('password');
  }, []);

  const submitPin = useCallback(
    async (pin: string): Promise<PinResult> => {
      try {
        const res = await api<{ csrf: string }>('/api/auth/pin', { body: { pin } });
        setCsrf(res.csrf);
        done();
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 'pin_blocked') {
            goPassword('PIN заблокирован. Войдите по паролю, затем придумайте новый PIN');
            return { ok: true };
          }
          if (e.code === 'need_password' || e.code === 'unauthorized') {
            goPassword(null);
            return { ok: true };
          }
          return { ok: false, error: e.code === 'network' ? 'Нет связи с сервером' : e.message };
        }
        return { ok: false, error: 'Не удалось проверить PIN' };
      }
    },
    [done, goPassword],
  );

  const submitSetup = useCallback(async (pin: string): Promise<PinResult> => {
    if (FORBIDDEN.includes(pin)) return { ok: false, error: 'Выберите менее очевидный PIN' };
    setFirstPin(pin);
    setSetupNotice(null);
    setStep('confirm');
    return { ok: true };
  }, []);

  const submitConfirm = useCallback(
    async (pin: string): Promise<PinResult> => {
      if (pin !== firstPin) {
        setFirstPin('');
        setSetupNotice('PIN не совпал. Придумайте PIN заново');
        setStep('setup');
        return { ok: true };
      }
      try {
        const res = await api<{ csrf: string }>('/api/auth/pin/setup', { body: { pin } });
        setCsrf(res.csrf);
        done();
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 'weak_pin') {
            setFirstPin('');
            setSetupNotice('Выберите менее очевидный PIN');
            setStep('setup');
            return { ok: true };
          }
          if (e.code === 'unauthorized') {
            goPassword('Время создания PIN истекло. Войдите по паролю ещё раз');
            return { ok: true };
          }
          return { ok: false, error: e.code === 'network' ? 'Нет связи с сервером' : e.message };
        }
        return { ok: false, error: 'Не удалось сохранить PIN' };
      }
    },
    [firstPin, done, goPassword],
  );

  return (
    <main className="auth-screen">
      <Wordmark big tone="light" />
      {step === 'password' && (
        <PasswordForm
          notice={passwordNotice}
          onSuccess={(needPinSetup) => {
            setPasswordNotice(null);
            setSetupNotice(null);
            setStep(needPinSetup ? 'setup' : 'pin');
          }}
        />
      )}
      {step === 'pin' && (
        <PinPad
          key="pin"
          title="Введите PIN"
          onSubmit={submitPin}
          footer={
            <button type="button" className="linkish" onClick={() => goPassword(null)}>
              Войти по паролю
            </button>
          }
        />
      )}
      {step === 'setup' && (
        <PinPad
          key="setup"
          title="Придумайте PIN из 4 цифр"
          subtitle="Он будет открывать приложение на этом устройстве"
          initialError={setupNotice}
          onSubmit={submitSetup}
        />
      )}
      {step === 'confirm' && (
        <PinPad key="confirm" title="Повторите PIN" subtitle="Введите тот же PIN ещё раз" onSubmit={submitConfirm} />
      )}
    </main>
  );
}

function PasswordForm({
  notice,
  onSuccess,
}: {
  notice: string | null;
  onSuccess: (needPinSetup: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const hydrated = useHydrated();
  const loginRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const login = loginRef.current?.value ?? '';
    const password = passRef.current?.value ?? '';
    if (!login.trim() || !password) {
      setError('Введите логин и пароль');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ needPinSetup?: boolean; needPin?: boolean }>('/api/auth/login', {
        body: { login, password },
      });
      if (passRef.current) passRef.current.value = '';
      onSuccess(Boolean(res.needPinSetup));
    } catch (err) {
      if (passRef.current) passRef.current.value = '';
      if (err instanceof ApiError) {
        setError(err.code === 'network' ? 'Нет связи с сервером' : err.message);
      } else {
        setError('Не удалось выполнить вход');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      method="post"
      onSubmit={submit}
      style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {notice ? (
        <p role="status" className="pin-sub" style={{ marginTop: 0 }}>
          {notice}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="pva-login">Логин</label>
        <input
          id="pva-login"
          ref={loginRef}
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={AUTH.maxLoginLength}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="pva-password">Пароль</label>
        <div className="with-eye">
          <input
            id="pva-password"
            ref={passRef}
            name="current-password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={AUTH.maxPasswordLength}
            required
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
            aria-pressed={show}
          >
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {show ? (
                <>
                  <path d="M3 3l18 18" />
                  <path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c5 0 8.5 4 9.5 6a12.5 12.5 0 0 1-2.6 3.3M6.1 7.7A12.6 12.6 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.5 0 2.8-.4 4-.9" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </>
              ) : (
                <>
                  <path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>
      <p className="form-error" role="alert">
        {error}
      </p>
      <button type="submit" className="btn" disabled={busy || !hydrated} style={{ width: '100%' }}>
        {busy ? 'Проверяем…' : 'Войти'}
      </button>
    </form>
  );
}
