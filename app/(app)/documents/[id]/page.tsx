import type { Metadata } from 'next';
import { DocumentView } from '@/components/documents/DocumentView';

export const metadata: Metadata = { title: 'Документ · Агент по НДС' };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentView id={id} />;
}
