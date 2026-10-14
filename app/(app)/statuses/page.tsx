import type { Metadata } from 'next';
import { StatusesView } from '@/components/provenance/StatusesView';

export const metadata: Metadata = { title: 'Что проверено · Агент по НДС' };

export default function StatusesPage() {
  return <StatusesView />;
}
