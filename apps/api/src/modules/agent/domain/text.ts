/** Small text rules for chat: turning a message into search terms and matching product FAQs. */

const STOP = new Set(
  (
    'show me find search searching looking look for need want a an the some any please pls i im my is are it its this that these those ' +
    'what which how much many price prices cost costs rate under below above over within budget upto up to of in on with and or can ' +
    'you do does have has get buy give good best cheap cheaper recommend suggest options option one ones there here hi hello hey ' +
    'available stock about tell more details be will would could should at from by as your our we us they them gift rs inr rupees ' +
    'mujhe chahiye chaiye dikhao dhundo koi ek acha achha accha badhiya bhai kitne kitna ka ki ke hai hain kya ye yeh wala wali wale ' +
    'mein se ko aur de dedo mai main tak liye kuch sasta मुझे चाहिए दिखाओ एक कोई का की के है हैं क्या यह ये में से को और कितने कितना'
  ).split(' '),
);

/** Content words of a shopping message: "show me dark chocolate under 500" -> "dark chocolate". */
export function searchTerms(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/₹?\s?\d[\d,.]*\s?(?:k|lakh|lac|crore)?/g, ' ')
    .split(/[^\p{L}\p{M}\p{N}-]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .join(' ');
}

const normal = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/** Exact FAQ match (ignoring case and punctuation): answered by rules, no model needed. */
export function matchFaq(faqs: readonly { q: string; a: string }[], text: string): string | null {
  const t = normal(text);
  return faqs.find((f) => normal(f.q) === t)?.a ?? null;
}

/** Cache key part for "the same question", whatever the punctuation or case. */
export const questionKey = (text: string): string => normal(text);

/** First UUID in a message, e.g. an order id. */
export const findUuid = (text: string): string | null =>
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(text)?.[0]?.toLowerCase() ?? null;

/** SKU-looking tokens ("THOCK-TK87-RED", "MITTI-MUG-WHITE"), not words like "t-shirt"; at most three. */
export const skuCandidates = (text: string): string[] =>
  (text.match(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g) ?? [])
    .filter((t) => /\d/.test(t) || t.split('-').length >= 3)
    .slice(0, 3)
    .map((t) => t.toUpperCase());
