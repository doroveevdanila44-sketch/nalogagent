import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { getServerAuth } from '@/lib/auth/server';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Серверная проверка входа для всех страниц после логина. Прокси проверяет только наличие cookie,
 * здесь проверяются токен, срок сессии, PIN и простой. Не вошёл или заблокирован по PIN: на /login,
 * где показывается нужный экран.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getServerAuth();
  if (auth.state !== 'ok' || !auth.csrf) {
    const path = (await headers()).get('x-pathname');
    const next = path === '/agent' || path === '/dashboard' ? `?next=${encodeURIComponent(path)}` : '';
    redirect(`/login${next}`);
  }
  const env = getEnv();
  return (
    <AppShell csrf={auth.csrf} idleMinutes={env.pinIdleMinutes} backgroundSeconds={env.pinBackgroundSeconds}>
      {children}
    </AppShell>
  );
}
