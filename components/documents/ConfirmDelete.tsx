'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { Overlay, OverlayHead } from '@/components/provenance/Overlay';
import { errorText } from '@/components/provenance/client';

/** Сколько секунд на экране уведомление «Черновик удалён» с кнопкой «Отменить» */
export const UNDO_SECONDS = 6;

/**
 * Окно подтверждения внутри страницы: «Удалить черновик? Черновик будет удалён. Отменить можно в
 * течение 6 секунд», кнопки «Удалить» (красная) и «Отмена». Для нескольких черновиков в заголовке их
 * число. Само удаление выполняет этот компонент (POST /api/documents/delete), результат отдаёт
 * вызывающему; «Отменить» в уведомлении после удаления возвращает черновики.
 */
export function ConfirmDelete({
  ids,
  onClose,
  onDeleted,
}: {
  ids: string[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const many = ids.length > 1;
  const title = many ? `Удалить черновики: ${ids.length}?` : 'Удалить черновик?';

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ids: string[] }>('/api/documents/delete', { body: { ids } });
      onDeleted(res.ids);
    } catch (e) {
      setError(errorText(e, 'Не удалось удалить. Повторите.'));
      setBusy(false);
    }
  };

  return (
    <Overlay kind="modal" label={title} onClose={onClose}>
      <OverlayHead title={title} onClose={onClose} />
      <div className="ov-scroll">
        <p data-testid="confirm-text">
          {`${many ? 'Черновики будут удалены' : 'Черновик будет удалён'}. Отменить можно в течение ${UNDO_SECONDS} секунд`}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts" role="group" aria-label="Подтверждение удаления">
          <button type="button" className="act danger" data-action="delete-confirm" disabled={busy} onClick={() => void run()}>
            {busy ? 'Удаляю…' : 'Удалить'}
          </button>
          <button type="button" className="act ghost" data-action="delete-cancel" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/** Вернуть только что удалённые черновики (кнопка «Отменить» в уведомлении). */
export async function restoreDrafts(ids: string[]): Promise<void> {
  await api('/api/documents/restore', { body: { ids } });
}
