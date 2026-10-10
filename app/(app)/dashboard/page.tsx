import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/DashboardView';

export const metadata: Metadata = { title: 'Дашборд · Агент по НДС' };

export default function DashboardPage() {
  return <DashboardView />;
}
