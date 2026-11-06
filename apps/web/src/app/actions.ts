'use server';

import { cookies } from 'next/headers';
import { COOKIE } from '@/lib/session';

/** Language switch (works without JavaScript). Setting a cookie re-renders the current page. */
export async function setLanguage(formData: FormData): Promise<void> {
  const lang = formData.get('lang') === 'hi' ? 'hi' : 'en';
  (await cookies()).set(COOKIE.lang, lang, {
    path: '/',
    maxAge: 365 * 24 * 3600,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });
}
