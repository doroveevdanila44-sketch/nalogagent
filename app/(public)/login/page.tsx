import type { Viewport } from 'next';
import { redirect } from 'next/navigation';
import { LoginFlow } from '@/components/auth/LoginFlow';
import { getServerAuth } from '@/lib/auth/server';
import { THEME } from '@/lib/theme';

export const dynamic = 'force-dynamic';

/** Вход и PIN бордовые целиком: полоса под часами с первого кадра совпадает с экраном */
export const viewport: Viewport = { themeColor: THEME.auth };

const ALLOWED_NEXT = new Set(['/agent', '/dashboard']);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; mode?: string }>;
}) {
  const sp = await searchParams;
  const next = sp.next && ALLOWED_NEXT.has(sp.next) ? sp.next : '/agent';
  const auth = await getServerAuth();

  if (auth.state === 'ok') redirect(next);

  const forcePassword = sp.mode === 'password';
  const initial = forcePassword || auth.state === 'anonymous' ? 'anonymous' : auth.state;

  return <LoginFlow initial={initial} next={next} />;
}
