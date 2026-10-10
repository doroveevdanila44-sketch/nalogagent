import type { Metadata, Viewport } from 'next';
import { Onest } from 'next/font/google';
import './globals.css';

/**
 * Один шрифт интерфейса, переменная ось веса одним файлом на подмножество. В интерфейсе
 * используются только 400, 500 и 600; курсива и 700 нет (стили не запрашивают их, жирное это 600).
 * Orbitron подключается отдельно и только для знака (components/Wordmark.tsx).
 */
const onest = Onest({
  subsets: ['cyrillic', 'latin'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-onest',
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
  appleWebApp: { capable: true, title: 'НДС', statusBarStyle: 'default' },
  other: { 'apple-mobile-web-app-capable': 'yes', 'mobile-web-app-capable': 'yes' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Экранная клавиатура уменьшает раскладочный вьюпорт (Chrome на Android): поле ввода и 100dvh
  // оказываются прямо над ней. Для Safari на iOS то же делает lib/client/keyboard.ts.
  interactiveWidget: 'resizes-content',
  themeColor: '#CA9C68',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={onest.variable}>
      <body>{children}</body>
    </html>
  );
}
