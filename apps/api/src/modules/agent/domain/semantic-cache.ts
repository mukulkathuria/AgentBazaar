import { redact } from '../../../shared/observability/redact.js';
import { searchTerms } from './text.js';

/**
 * Rules for reusing model wording safely. A cached reply is stored with every number replaced by a
 * slot that points at a number of the policy template it rephrased. A later request may reuse it only
 * for a template with the same wording around its numbers, and every slot is re-filled from that
 * request's own template, so prices, totals, quantities and times always come from the current policy.
 */

/** Numbers as templates and replies write them: 5,499 / 1,23,456 / 2,399.50 / 03. */
const NUMBER = /\d+(?:,\d+)*(?:\.\d+)?/g;
// Slot i is the private-use character U+E000 + i, so a stored reply holds no digit at all.
const SLOT_BASE = 0xe000;
const MAX_SLOTS = 256;
const SLOT = /[-]/g;

const valueOf = (token: string): number => Number(token.replace(/,/g, ''));

export interface TemplateShape {
  /** The template with every number masked: requests may share a cached reply only if these are equal. */
  skeleton: string;
  /** The template's numbers as written, in order. */
  numbers: string[];
}

export function templateShape(template: string): TemplateShape {
  const numbers: string[] = [];
  const skeleton = template.replace(NUMBER, (n) => {
    numbers.push(n);
    return '#';
  });
  return { skeleton, numbers };
}

export interface Slotted {
  /** The reply with every number replaced by a template slot. */
  text: string;
  /**
   * Template slots that held the same value when a reply number matched them all (a quote's unit
   * price and total for one item). A later template must hold equal values in each group to reuse it.
   */
  same: number[][];
}

/**
 * The reply with each number turned into the slot of the template number it repeats, or null when a
 * number is not in the template at all, or a digit is left over. Such replies are simply not cached.
 */
export function toSlots(reply: string, numbers: readonly string[]): Slotted | null {
  if (numbers.length > MAX_SLOTS) return null;
  const values = numbers.map(valueOf);
  const same: number[][] = [];
  let unknown = false;
  // NUMBER runs in linear time (digit runs split by fixed "," and "." delimiters); njsscan reads (reply, numbers) as (req, res).
  const text = reply.replace(NUMBER, (n) => { // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    const at = values.flatMap((v, i) => (v === valueOf(n) ? [i] : []));
    if (!at.length) unknown = true;
    if (at.length > 1) same.push(at);
    return String.fromCharCode(SLOT_BASE + (at[0] ?? 0));
  });
  return unknown || /\p{Nd}/u.test(text) ? null : { text, same };
}

/** Fills a slotted reply with the current template's numbers; null if a slot is missing or a group differs. */
export function fillSlots(slotted: Slotted, numbers: readonly string[]): string | null {
  const values = numbers.map(valueOf);
  if (slotted.same.some((g) => g.some((i) => values[i] === undefined || values[i] !== values[g[0]!]))) return null;
  let missing = false;
  const text = slotted.text.replace(SLOT, (s) => {
    const n = numbers[s.charCodeAt(0) - SLOT_BASE];
    if (n === undefined) missing = true;
    return n ?? '';
  });
  return missing ? null : text;
}

const words = (text: string): Set<string> => new Set(text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}]+/u));

/**
 * The reply repeats a content word of the buyer's message that neither the template nor the facts
 * contain, typically a name ("Sure Rahul!"). Such a reply is personal and must never be shared.
 */
export function echoesBuyer(reply: string, buyerText: string, known: string): boolean {
  const buyer = words(searchTerms(buyerText));
  const vocabulary = words(known);
  return [...words(reply)].some((w) => w.length > 1 && buyer.has(w) && !vocabulary.has(w));
}

/** The buyer's message as the cache compares it: personal data redacted, numbers masked, case and spacing folded. */
export const cacheContext = (text: string): string =>
  redact(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu, '#')
    .replace(/\s+/g, ' ')
    .trim();

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
