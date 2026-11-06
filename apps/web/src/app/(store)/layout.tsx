import type { ReactNode } from 'react';
import { ChatWidget } from '@/components/chat/chat-widget';
import { getI18n } from '@/lib/i18n/server';

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const { lang } = await getI18n();
  return (
    <>
      {children}
      {/* Keyed by language: switching language starts a fresh chat session in that language. */}
      <ChatWidget key={lang} />
    </>
  );
}
