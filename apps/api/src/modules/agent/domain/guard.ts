import { findPii } from '../../../shared/observability/redact.js';

/**
 * Output guard for model-written replies. Every number must be one the services produced, so a model
 * can rephrase a price but never invent, round or reveal one. Links, contact details, personal data,
 * talk of floors, costs or margins, and free-of-charge promises are refused outright. Fail closed:
 * anything that looks like a number counts as one, and a refused reply is replaced by the template.
 */
export type GuardIssue = 'number' | 'spelled_number' | 'link' | 'contact' | 'personal_data' | 'secret_terms' | 'free_offer';

export interface GuardVerdict {
  ok: boolean;
  issues: GuardIssue[];
}

const L = '\\p{L}\\p{M}';
const before = `(?<![${L}])`;
const after = `(?![${L}])`;

/** NFKC, nukta dropped, Devanagari digits to ASCII, lower case. */
function canon(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/़/g, '')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .toLowerCase();
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, 'हजार': 1e3,
  l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, 'लाख': 1e5,
  million: 1e6, mn: 1e6,
  cr: 1e7, crore: 1e7, crores: 1e7, 'करोड': 1e7,
  bn: 1e9, billion: 1e9,
}; // prettier-ignore

// Indian (1,23,456) or western (123,456) grouping, optional decimals, optional "k" / "lakh" / "crore".
const NUMBER = new RegExp(`(\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.(\\d+))?(?:\\s?(${Object.keys(MULTIPLIERS).join('|')})(?![${L}\\p{N}]))?`, 'gu');
// Digits from other scripts would slip past \d, so any non-ASCII decimal digit is refused.
const FOREIGN_DIGIT = /(?=\p{Nd})[^0-9]/u;

const NUM_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen' +
  '|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|ek|do|teen|char|chaar|paanch|panch|chhe|saat|aath|nau|das' +
  '|bees|pachas|dedh|dhai|sava|saade|sade|एक|दो|तीन|चार|पांच|छह|सात|आठ|नौ|दस|बीस|पचास|डेढ|ढाई|सवा|साढे';
const MAGNITUDES = 'hundred|thousand|lakhs?|lacs?|crores?|million|billion|sau|hazaa?r|सौ|हजार|लाख|करोड';
const CURRENCY = '₹|rs\\.?|inr|rupees?|rupaye|rupay|bucks|रुपये|रुपए|रु';
const WORDS = `(?:${NUM_WORDS})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUM_WORDS}))*`;
// "eighteen hundred", "do hazaar", "two thousand rupees", "rs twenty": amounts spelled out to dodge the digit check.
// A word before a currency sign that digits follow is not an amount ("I can do ₹4,999"): the digits are checked.
const SPELLED = new RegExp(
  `${before}(?:(?:a|an|${WORDS})[\\s-]+(?:${MAGNITUDES})|${WORDS}[\\s-]+(?:${CURRENCY})(?![.\\s]*\\p{Nd}))${after}|(?:${CURRENCY})\\s*(?:${NUM_WORDS})${after}`,
  'u',
);

const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|io|ai|co|app|dev|shop|store|xyz|info|me|biz|link|ly)\b/u;

const SECRET_TERMS = new RegExp(
  `${before}(?:floor|cost ?price|our cost|my cost|unit cost|landed cost|at cost|below cost|cost to (?:us|me)|margins?|mark-?ups?` +
    '|profits?|break-?even|wholesale|purchase price|buying price|reserve price|minimum (?:acceptable )?price|system prompt' +
    `|lagat|laagat|munafa|मार्जिन|लागत|मुनाफा|फ्लोर)${after}`,
  'u',
);

const FREE_OFFER = new RegExp(
  `${before}(?:for free|free of (?:cost|charge)|on the house|half (?:the )?price|buy one get one|bogo|complimentary|free mein|muft|मुफ्त|फ्री में)${after}`,
  'u',
);

function numbersIn(canonical: string): number[] {
  return [...canonical.matchAll(NUMBER)].map((m) => {
    const value = Number(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    return value * (m[3] ? (MULTIPLIERS[m[3]] ?? 1) : 1);
  });
}

/** Every numeric value a reader would see in `text`, e.g. "₹2,399" -> 2399, "1.5 lakh" -> 150000. */
export function extractNumbers(text: string): number[] {
  return numbersIn(canon(text));
}

const isAllowed = (n: number, allowed: readonly number[]): boolean => allowed.some((a) => Math.abs(a - n) < 0.005);

/** Checks a model-written reply. `allowed` lists every number the reply may contain. */
export function checkReply(text: string, allowed: Iterable<number>): GuardVerdict {
  const c = canon(text);
  const allow = [...allowed];
  const issues = new Set<GuardIssue>();
  if (FOREIGN_DIGIT.test(c) || numbersIn(c).some((n) => !isAllowed(n, allow))) issues.add('number');
  if (SPELLED.test(c)) issues.add('spelled_number');
  if (LINK.test(c)) issues.add('link');
  for (const f of findPii(text)) issues.add(f.type === 'EMAIL' || f.type === 'PHONE' ? 'contact' : 'personal_data');
  if (SECRET_TERMS.test(c)) issues.add('secret_terms');
  if (FREE_OFFER.test(c)) issues.add('free_offer');
  return { ok: issues.size === 0, issues: [...issues] };
}
