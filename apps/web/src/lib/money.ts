import type { Language } from '@agentbazaar/contracts';

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Same output as `formatInr` from @agentbazaar/contracts (price.test.tsx pins them together). Client components
 * use this copy because importing anything at runtime from the contracts barrel ships all of Zod to the browser.
 */
export function inr(paise: number, lang: Language = 'en'): string {
  const whole = paise % 100 === 0;
  const key = `${lang}:${whole}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang === 'hi' ? 'hi-IN' : 'en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f.format(paise / 100);
}
