import type { Metadata, Viewport } from 'next';
import { Manrope, Montserrat } from 'next/font/google';
import { KeyboardViewport } from '@/components/KeyboardViewport';
import { THEME } from '@/lib/theme';
import './globals.css';
import './roborab-ui.css';

/**
 * Два шрифта дизайн-кода РОБОРАБ v3 (docs/DESIGN.md, раздел 3). Montserrat: заголовки, цифры, кнопки,
 * метки; курсив 900 и 800 в заголовках, ровный 800 в кнопках, метках и вкладках (раздел 10.1).
 * Manrope: основной текст, формы, подписи, данные; в стилях используются 400, 500, 700, 800.
 * Переменная ось веса одним файлом на начертание, подмножества cyrillic и latin.
 */
const montserrat = Montserrat({
  subsets: ['cyrillic', 'latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-montserrat',
});

const manrope = Manrope({
  subsets: ['cyrillic', 'latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-manrope',
});

export const metadata: Metadata = {
  title: 'Агент по НДС',
  description: 'Закрытое приложение для собственника группы компаний',
  applicationName: 'Агент по НДС',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  // Установленный НДС использует системный статус-бар iOS, чтобы не терять область у нижнего края.
  appleWebApp: { capable: true, title: 'НДС' },
  other: { 'apple-mobile-web-app-capable': 'yes', 'mobile-web-app-capable': 'yes' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Экранная клавиатура уменьшает раскладочный вьюпорт только у Chrome на Android. Safari на iOS и
  // установленное на экран приложение этого не умеют: у них уменьшается лишь visualViewport, и высоту
  // оболочки задаёт --vvh (lib/client/keyboard.ts), а не 100vh или 100dvh.
  interactiveWidget: 'resizes-content',
  themeColor: THEME.app,
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${montserrat.variable} ${manrope.variable}`}>
      <body>
        <KeyboardViewport />
        {children}
      </body>
    </html>
  );
}
