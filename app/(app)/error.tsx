'use client';

import Link from 'next/link';

/**
 * Сбой при отрисовке страницы внутри приложения: шапка и панель вкладок остаются, в области
 * содержимого короткое сообщение и «Повторить». Текст ошибки не показывается (в нём могут быть данные).
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="err-screen err-inline" role="alert" data-testid="app-error">
      <h1>Что-то пошло не так</h1>
      <p>Страница не открылась. Повторите, цифры при этом не потеряны.</p>
      <div className="err-acts">
        <button type="button" className="btn" onClick={() => reset()}>
          Повторить
        </button>
        <Link className="btn btn-ghost" href="/agent" prefetch={false}>
          В чат
        </Link>
      </div>
    </div>
  );
}
