'use client';

import type { Language } from '@agentbazaar/contracts';
import { createContext, use, type ReactNode } from 'react';
import type { Dict } from './en';

interface I18n {
  lang: Language;
  t: Dict;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ lang, t, children }: I18n & { children: ReactNode }) {
  return <I18nContext value={{ lang, t }}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
