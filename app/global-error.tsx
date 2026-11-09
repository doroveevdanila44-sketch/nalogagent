'use client';

import { useEffect } from 'react';
import { logBoundaryError } from '@/lib/client/report-error';

/**
 * Сбой самого корня приложения (layout не отрисовался): стили сайта не загружены, поэтому всё
 * задано на месте. Кнопка перезагружает страницу.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => logBoundaryError('global-error', error), [error]);
  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
          fontFamily: 'Manrope, system-ui, -apple-system, "Segoe UI", sans-serif',
          background: '#F4F4F2',
          color: '#141414',
        }}
      >
        <h1
          style={{
            fontFamily: 'Montserrat, Manrope, system-ui, sans-serif',
            fontStyle: 'italic',
            fontSize: 24,
            fontWeight: 900,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            margin: 0,
          }}
        >Что-то пошло не так</h1>
        <p style={{ margin: 0, color: 'rgba(20,20,20,.64)', maxWidth: '32ch', lineHeight: 1.45 }}>
          Приложение не открылось. Повторите через несколько секунд.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 44,
            padding: '0 20px',
            border: 0,
            borderRadius: 999,
            background: '#141414',
            color: '#fff',
            font: 'inherit',
            fontFamily: 'Montserrat, Manrope, system-ui, sans-serif',
            fontWeight: 800,
          }}
        >
          Повторить
        </button>
      </body>
    </html>
  );
}
