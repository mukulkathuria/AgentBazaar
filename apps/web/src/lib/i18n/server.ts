import type { Language } from '@agentbazaar/contracts';
import { cookies } from 'next/headers';
import { COOKIE } from '../session';
import { en, type Dict } from './en';
import { hi } from './hi';

const DICTIONARIES: Record<Language, Dict> = { en, hi };

/**
 * Language from the `lang` cookie. Reading the cookie also opts the page into request-time rendering,
 * so pages call this before any fetch and nothing is fetched at build time.
 */
export async function getI18n(): Promise<{ lang: Language; t: Dict }> {
  const lang: Language = (await cookies()).get(COOKIE.lang)?.value === 'hi' ? 'hi' : 'en';
  return { lang, t: DICTIONARIES[lang] };
}
