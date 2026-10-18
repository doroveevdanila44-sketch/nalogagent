'use client';

import { useState } from 'react';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';
import { api } from '@/lib/client/api';

/**
 * Окно подтверждения «Очистить чат?». Само удаление выполняет этот компонент (DELETE /api/chat),
 * результат отдаёт вызывающему. Вернуть стёртое нельзя, поэтому кнопка красная, а в тексте сказано,
 * что остаётся: документы, запросы на проверку и отметки «сверил» хранят свои данные отдельно.
 */
export function ClearChat({ onClose, onCleared }: { onClose: () => void; onCleared: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/chat', { method: 'DELETE' });
      onCleared();
    } catch (e) {
      setError(errorText(e, 'Не удалось очистить чат. Повторите.'));
      setBusy(false);
    }
  };

  return (
    <Overlay kind="modal" label="Очистить чат?" onClose={onClose}>
      <OverlayHead title="Очистить чат?" onClose={onClose} />
      <div className="ov-scroll">
        <p data-testid="clear-chat-text">
          Все вопросы и ответы будут удалены без возможности восстановления. Документы, запросы на проверку и
          отметки «сверил» останутся.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts" role="group" aria-label="Подтверждение очистки чата">
          <button type="button" className="act danger" data-action="clear-confirm" disabled={busy} onClick={() => void run()}>
            {busy ? 'Очищаю…' : 'Очистить'}
          </button>
          <button type="button" className="act ghost" data-action="clear-cancel" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </Overlay>
  );
}
