import type { ClassifyResponse, DetectedLanguage, Intent, Language, Level } from '@agentbazaar/contracts';
import {
  ACCEPT_FILLERS, B, BUDGET, CLAIM, COMPATIBILITY, CONCESSION, CUES, DAN, DEADLINE, E, GREETINGS, GREETING_FILLERS,
  HINGLISH, OFFER_STRONG, OFFER_WEAK, PRODUCTS, SELLS, SMALL_TALK, SPECS, STORES, TOKENS, WEAK_ACCEPT, WORD, canon,
  fold, raw,
} from './intent-cues.js';

/**
 * Intent classification for shopping chat in English, Hindi (Devanagari) and Hinglish: a faithful port of
 * the deterministic "rules-v1" backend of services/ai classifier.py. Text is folded (see `fold`), each intent
 * has a table of cue phrases, and the first intent in priority order with a matching cue wins.
 */
export const RULES_MODEL = 'rules-v1';

/** `_hits`: how many distinct strings the regex matches. */
const count = (re: RegExp, s: string): number => new Set(Array.from(s.matchAll(re), (m) => m[0])).size;
const has = (re: RegExp, s: string): boolean => s.search(re) >= 0;
const compile = (source: string, flags = 'gu'): RegExp => new RegExp(canon(source), flags);

/**
 * Python's round(x, n): the exact decimal value, ties to even. toFixed rounds the exact value too but breaks
 * ties upwards; with n decimals an exact tie is an odd multiple of 2^-(n+1).
 */
function pyRound(x: number, n: number): number {
  const scale = 10 ** n;
  return (x * 2 ** (n + 1)) % 2 === 1 ? (2 * Math.round((x * scale) / 2)) / scale : Number(x.toFixed(n));
}

// --- entities ------------------------------------------------------------------------------------------------

const DIGITS = raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?(?!\d)`; // Indian and western digit grouping
const NUM = raw`(?<![\d.,])${DIGITS}`; // never starts mid-number
const MULT = raw`(?:k|thousand|hazaa?r|हज़ार|lakhs?|lacs?|लाख|crores?|cr|करोड़)`;
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, [canon('हज़ार')]: 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, 'लाख': 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7, [canon('करोड़')]: 1e7,
};
const CUR_PRE = raw`(?:₹|(?<![a-z])(?:rs\.?|inr|rupees?)|रु\.?|रुपये|रुपए)`;
const CUR_POST = raw`(?:₹|(?:rs|inr|rupees?|rupaye|rupay|rupiya|rupaiya)(?![a-z])\.?|/-|रुपये|रुपए|रुपया|रु)`;
const UNIT = raw`\s?(?:%|gb|tb|mb|kb|mah|w|watts?|v|hz|ghz|mhz|inch(?:es)?|in|"|ft|mm|cm|m|km|kg|g|gms?|grams?|mg|
  ml|l|ltr|litres?|liters?|mp|p|fps|x|am|pm|th|st|nd|rd|yrs?|years?|months?|days?|hours?|hrs?|mins?|minutes?|
  weeks?|people|persons?|pax|seater|units?|pcs?|pieces?|nos|items?|packs?|packets?|boxes|bottles|sets?|pairs?|
  पीस|नग)(?![${WORD}])`;
const SCREEN = raw`(?!\s?(?:tvs?|monitors?|display|video|resolution|uhd|hdr|screen|camera|oled|qled|
  led)(?![${WORD}]))`;
const AMOUNT_PATTERNS: [kind: string, patterns: RegExp[]][] = [
  [
    'currency',
    [
      compile(raw`${CUR_PRE}\s?(?<n>${DIGITS})(?:\s?(?<m>${MULT})(?![${WORD}]))?`),
      compile(raw`(?<n>${NUM})(?:\s?(?<m>${MULT}))?\s?${CUR_POST}`),
    ],
  ],
  ['multiplier', [compile(raw`(?<n>${NUM})\s?(?<m>${MULT})(?![${WORD}])${SCREEN}`)]],
  [
    'cue',
    [
      compile(raw`${B}(?:can you do|could you do|would you do|will you do|do|for|at|offer(?:ing)?|pay|give|take|
        budget(?: is| of)?|how about|what about|max(?:imum)?|under|below|upto|up to|within|around|only|just|final|
        make it|settle (?:for|at)):?\s(?<n>${NUM})(?!${UNIT})(?!\s?${MULT}(?![${WORD}]))`),
      compile(raw`(?<n>${NUM})(?!${UNIT})\s(?:mein|me|mai|main|tak|final|chalega|chalegi|dunga|dungi|de do|dedo|
        kar do|lagao|max|only|fixed|ok|ka|ki|ke|में|तक|फाइनल|चलेगा|दूंगा|का|की|के)${E}`),
    ],
  ],
];
// Python's fullmatch: a message that is only an amount reads as an offer.
const BARE_AMOUNT = compile(
  raw`^(?:${CUR_PRE}?\s?(?<n>${DIGITS})(?:\s?(?<m>${MULT}))?\s?${CUR_POST}?\s?[?!.]*)$`,
  'u',
);
const QUANTITY = [
  compile(raw`(?<![\d.,])(?<n>\d+)\s?(?:units?|pcs?|pieces?|nos|packs?|packets?|boxes|bottles|sets?|pairs?|
    पीस|नग)(?![${WORD}])`),
  compile(raw`(?<![${WORD}])(?:qty|quantity|qnty)\s?[:=#-]?\s?(?<n>\d+)(?!\d)`),
  compile(raw`(?<![${WORD}.])[x×]\s?(?<n>\d+)(?![\d.])(?!\s?[x×*])(?!\s?(?:cm|mm|in|inch|
    inches|ft|m)(?![${WORD}]))`),
];

/** `_value`: the number times its k/lakh/crore multiplier; an overflow (inf) is no amount. */
function value(m: RegExpMatchArray): number | null {
  const v = Number(m.groups?.n?.replaceAll(',', '')) * (MULTIPLIERS[m.groups?.m ?? ''] ?? 1);
  return Number.isFinite(v) ? pyRound(v, 2) : null;
}

/** First amount of the strongest kind: currency-marked > k/lakh/crore > after an offer cue. */
function amountOf(folded: string): [amount: number | null, kind: string] {
  const bare = BARE_AMOUNT.exec(folded);
  const bareValue = bare && value(bare);
  if (bareValue !== null && bareValue >= 10) return [bareValue, 'bare'];
  for (const [kind, patterns] of AMOUNT_PATTERNS) {
    const found = patterns
      .flatMap((p) => Array.from(folded.matchAll(p), (m) => [m.index, value(m)] as const))
      .filter((f): f is readonly [number, number] => f[1] !== null && (kind !== 'cue' || f[1] >= 10))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (found[0]) return [found[0][1], kind];
  }
  return [null, ''];
}

function quantityOf(folded: string): number | null {
  // By start, like Python's sort by (start, digits): starts never tie, as the patterns begin with a digit, q and x.
  const found = QUANTITY.flatMap((p) => [...folded.matchAll(p)]).sort((a, b) => a.index - b.index);
  for (const m of found) {
    const digits = m.groups?.n ?? '';
    if (digits.length <= 16 && Number(digits) <= Number.MAX_SAFE_INTEGER) return Number(digits);
  }
  return null;
}

export function extractEntities(text: string): ClassifyResponse['entities'] {
  const folded = fold(text);
  return { amount_inr: amountOf(folded)[0], quantity: quantityOf(folded) };
}

// --- language, complexity, risk ------------------------------------------------------------------------------

/** Letters (Python's isalpha) of the NFKC text, by script. */
function scripts(text: string): { deva: number; latin: number; other: number } {
  const n = { deva: 0, latin: 0, other: 0 };
  for (const ch of text.normalize('NFKC').match(/\p{L}/gu) ?? []) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff)) n.deva++;
    else if (cp < 0x0250 || (cp >= 0x1e00 && cp <= 0x1eff)) n.latin++;
    else n.other++;
  }
  return n;
}

export function detectLanguage(text: string, hint?: Language): DetectedLanguage {
  const { deva, latin, other } = scripts(text);
  if (deva + latin + other === 0) return hint ?? 'en';
  if (deva >= latin && deva >= other) return 'hi';
  if (other > latin) return 'other';
  const markers = fold(text).match(HINGLISH)?.length ?? 0;
  return markers >= (hint === 'hi' ? 1 : 2) ? 'hinglish' : 'en';
}

function complexityOf(folded: string, amount: number | null, quantity: number | null): Level {
  const constraints = [
    amount !== null || has(BUDGET, folded),
    has(COMPATIBILITY, folded),
    has(SPECS, folded),
    quantity !== null,
    has(DEADLINE, folded),
    has(CUES.customization, folded),
  ].filter(Boolean).length;
  const words = folded ? folded.split(' ').length : 0;
  if (constraints >= 3 || words > 60) return 'high';
  if (constraints === 2 || words > 20) return 'medium';
  return 'low';
}

export function riskFor(intent: Intent, amount: number | null): Level {
  if (intent === 'injection_attempt') return 'high';
  if (intent === 'complaint' || (amount ?? 0) > 100_000) return 'medium';
  return 'low';
}

// --- decision ------------------------------------------------------------------------------------------------

// Priority order: safety first, then post-purchase, negotiation, then discovery.
const ORDER = [
  'injection_attempt', 'human_handoff', 'competitor_claim', 'complaint', 'order_status', 'return_request',
  'make_offer', 'accept', 'ask_price', 'customization', 'availability', 'search', 'product_question', 'off_topic',
  'greeting',
] as const satisfies readonly Intent[];
type Ranked = (typeof ORDER)[number];
const BASE_CONFIDENCE: Record<Ranked, number> = {
  injection_attempt: 0.8, human_handoff: 0.8, competitor_claim: 0.75, complaint: 0.7, order_status: 0.75,
  return_request: 0.7, make_offer: 0.7, accept: 0.7, ask_price: 0.75, customization: 0.75, availability: 0.7,
  search: 0.65, product_question: 0.6, off_topic: 0.65, greeting: 0.9,
};

const only = (words: readonly string[], core: ReadonlySet<string>, fillers: ReadonlySet<string>): boolean =>
  words.some((w) => core.has(w)) && words.every((w) => core.has(w) || fillers.has(w));

function shouting(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 12 && (text.match(/[A-Z]/g)?.length ?? 0) >= 0.7 * letters;
}

/** Hits per cue table, plus the boosts that do not depend on the other intents. */
function cueHits(folded: string, text: string, amount: number | null): Record<Ranked, number> {
  // make_offer and greeting have no table: intentOf fills them in.
  const hits = Object.fromEntries(
    Object.entries(CUES).map(([intent, re]) => [intent, count(re, folded)] as const),
  ) as Record<Ranked, number>;
  hits.injection_attempt += canon(text).match(DAN)?.length ?? 0;
  hits.complaint += Number(shouting(text));
  const stores = count(STORES, folded);
  if (stores && (amount !== null || has(CLAIM, folded))) hits.competitor_claim += stores;
  if (amount !== null && has(SELLS, folded)) hits.competitor_claim += 1;
  return hits;
}

function accepts(folded: string, hits: number): [hits: number, weak: boolean] {
  if (folded.includes('?')) return [0, false]; // "ok done?" asks; it does not accept
  if (!hits && only(folded.match(TOKENS) ?? [], WEAK_ACCEPT, ACCEPT_FILLERS)) return [1, true];
  return [hits, false];
}

function greets(folded: string): number {
  const rest = folded.replace(SMALL_TALK, ' ').match(TOKENS) ?? [];
  return Number(
    rest.every((w) => GREETINGS.has(w) || GREETING_FILLERS.has(w)) &&
      (has(SMALL_TALK, folded) || rest.some((w) => GREETINGS.has(w))),
  );
}

function intentOf(folded: string, text: string, amount: number | null, amountKind: string): [Intent, number] {
  const hits = cueHits(folded, text, amount);
  // An offer needs an amount, or asks the seller to come down. Weak cues ("for", "budget") only count
  // outside product searches.
  const shopping = hits.search || has(PRODUCTS, folded);
  const offer = count(OFFER_STRONG, folded) + (shopping ? 0 : count(OFFER_WEAK, folded));
  hits.make_offer = amount === null ? count(CONCESSION, folded) : offer + Number(amountKind === 'bare');
  const [accept, weakAccept] = accepts(folded, hits.accept);
  hits.accept = accept;
  hits.greeting = greets(folded);

  const matched = ORDER.filter((intent) => hits[intent]);
  const intent = matched[0];
  if (!intent) return has(PRODUCTS, folded) ? ['search', 0.45] : ['unknown', 0.2];
  const weak = intent === 'accept' ? weakAccept : intent === 'make_offer' && !offer;
  const base = weak ? 0.55 : BASE_CONFIDENCE[intent];
  const confidence = base + 0.08 * Math.min(hits[intent] - 1, 3) - 0.07 * (matched.length - 1);
  return [intent, pyRound(Math.min(0.97, Math.max(0.35, confidence)), 3)];
}

export function classifyRules(text: string, languageHint?: Language): ClassifyResponse {
  const folded = fold(text);
  const [amount, amountKind] = amountOf(folded);
  const quantity = quantityOf(folded);
  const [intent, confidence] = intentOf(folded, text, amount, amountKind);
  return {
    intent,
    complexity: complexityOf(folded, amount, quantity),
    risk: riskFor(intent, amount),
    language: detectLanguage(text, languageHint),
    confidence,
    entities: { amount_inr: amount, quantity },
    model: RULES_MODEL,
  };
}
