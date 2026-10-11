import type { Metadata } from 'next';
import { DocumentsView } from '@/components/documents/DocumentsView';

export const metadata: Metadata = { title: 'Документы · Агент по НДС' };

export default function DocumentsPage() {
  return <DocumentsView />;
}
