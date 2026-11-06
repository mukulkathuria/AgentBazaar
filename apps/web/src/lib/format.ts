import type { Language } from '@agentbazaar/contracts';

const LOCALE: Record<Language, string> = { en: 'en-IN', hi: 'hi-IN' };

/** Date and time in India Standard Time (the store's timezone), e.g. "5 Nov 2026, 4:32 pm". */
export function formatDateTime(iso: string, lang: Language): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d);
}

/** Fills `{name}` placeholders in dictionary strings. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}
