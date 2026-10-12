import type { Metadata } from 'next';
import { DocumentSheet } from '@/components/documents/DocumentSheet';

export const metadata: Metadata = { title: 'Документ · Агент по НДС' };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentSheet id={id} />;
}
