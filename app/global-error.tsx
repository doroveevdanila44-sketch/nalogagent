'use client';

/**
 * Сбой самого корня приложения (layout не отрисовался): стили сайта не загружены, поэтому всё
 * задано на месте. Кнопка перезагружает страницу.
 */
export default function GlobalError() {
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
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          background: '#fff',
          color: '#2A2B14',
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Что-то пошло не так</h1>
        <p style={{ margin: 0, color: '#6B6A52', maxWidth: '32ch', lineHeight: 1.45 }}>
          Приложение не открылось. Повторите через несколько секунд.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            minHeight: 44,
            padding: '0 20px',
            border: 0,
            borderRadius: 12,
            background: '#2A2B14',
            color: '#fff',
            font: 'inherit',
            fontWeight: 600,
          }}
        >
          Повторить
        </button>
      </body>
    </html>
  );
}
