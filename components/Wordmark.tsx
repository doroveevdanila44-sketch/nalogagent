import { Orbitron } from 'next/font/google';

/**
 * Знак luxauto41 живым текстом. Единственное место, где используется Orbitron
 * (приближение к логотипу клиента, SPEC.md раздел 5). Когда клиент даст векторный логотип,
 * этот компонент заменяется на SVG, а Orbitron убирается (docs/OPEN_QUESTIONS.md, вопрос 1).
 */
const orbitron = Orbitron({
  subsets: ['latin'],
  weight: ['500', '600'],
  display: 'swap',
  variable: '--font-orbitron',
});

/** tone="light" для тёмного коричневого фона экранов входа и PIN */
export function Wordmark({ big = false, tone = 'header' }: { big?: boolean; tone?: 'header' | 'light' }) {
  return (
    <div className={`wordmark ${big ? 'big' : ''} ${tone === 'light' ? 'light' : ''} ${orbitron.variable}`} role="img" aria-label="luxauto41">
      <span aria-hidden="true">luxauto</span>
      <span aria-hidden="true" className="n41">
        41
      </span>
    </div>
  );
}
