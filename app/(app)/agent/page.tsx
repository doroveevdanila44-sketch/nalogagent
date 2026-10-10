import type { Metadata } from 'next';
import { ChatView } from '@/components/chat/ChatView';

export const metadata: Metadata = { title: 'Агент · Агент по НДС' };

export default function AgentPage() {
  return <ChatView />;
}
