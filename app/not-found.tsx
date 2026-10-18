import Link from 'next/link';

export const metadata = { title: 'Страница не найдена · Агент по НДС' };

/** Адреса, которых нет: русская страница с возвратом в чат вместо английской заглушки Next.js. */
export default function NotFound() {
  return (
    <div className="err-screen" data-testid="not-found">
      <h1>Страница не найдена</h1>
      <p>Такого адреса в приложении нет. Вернитесь в чат или на дашборд.</p>
      <div className="err-acts">
        <Link className="btn" href="/agent" prefetch={false}>
          В чат
        </Link>
        <Link className="btn btn-ghost" href="/dashboard" prefetch={false}>
          На дашборд
        </Link>
      </div>
    </div>
  );
}
