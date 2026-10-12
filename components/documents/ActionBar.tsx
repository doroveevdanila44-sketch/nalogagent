'use client';

/**
 * Нижняя панель листа, закреплена внизу. Слева счётчик «Не заполнено: 7» (нажатие ведёт к первому
 * пропуску) со стрелками к следующему и предыдущему пропуску, справа «Дозаполнить» (основная) и
 * «Отправить»; на проверке вместо «Отправить» «Отозвать». Без пропусков счётчика и «Дозаполнить» нет.
 */
export function SheetActionBar({
  missing,
  canFill,
  canSubmit,
  canSend,
  canWithdraw,
  busy,
  counterId,
  onFirst,
  onNext,
  onPrev,
  onFill,
  onSend,
  onWithdraw,
}: {
  missing: number;
  /** Документ можно править */
  canFill: boolean;
  /** Обязательные поля заполнены: отправка доступна */
  canSubmit: boolean;
  /** Статус допускает отправку */
  canSend: boolean;
  canWithdraw: boolean;
  busy: boolean;
  counterId: string;
  onFirst: () => void;
  onNext: () => void;
  onPrev: () => void;
  onFill: () => void;
  onSend: () => void;
  onWithdraw: () => void;
}) {
  const arrow = (dir: 'prev' | 'next') => (
    <button
      type="button"
      className="bar-arrow"
      data-action={dir === 'next' ? 'missing-next' : 'missing-prev'}
      aria-label={dir === 'next' ? 'Следующее незаполненное поле' : 'Предыдущее незаполненное поле'}
      onClick={dir === 'next' ? onNext : onPrev}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={dir === 'next' ? 'm7 10 5 5 5-5' : 'm7 14 5-5 5 5'} />
      </svg>
    </button>
  );
  return (
    <div className="sheet-actions" role="region" aria-label="Действия с документом" data-testid="sheet-actions">
      {missing > 0 ? (
        <div className="bar-count">
          <button type="button" id={counterId} className="bar-counter" data-action="missing-first" onClick={onFirst}>
            Не заполнено: {missing}
          </button>
          {arrow('prev')}
          {arrow('next')}
        </div>
      ) : (
        <span />
      )}
      <div className="bar-buttons">
        {canFill && missing > 0 ? (
          <button type="button" className="act" data-action="complete" onClick={onFill}>
            Дозаполнить
          </button>
        ) : null}
        {canSend ? (
          <button
            type="button"
            className="act"
            data-action="submit"
            disabled={!canSubmit}
            aria-describedby={canSubmit ? undefined : counterId}
            onClick={onSend}
          >
            Отправить
          </button>
        ) : canWithdraw ? (
          <button type="button" className="act" data-action="withdraw" disabled={busy} onClick={onWithdraw}>
            Отозвать
          </button>
        ) : null}
      </div>
    </div>
  );
}
