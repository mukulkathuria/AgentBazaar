/**
 * Removes personal data from free text before it is logged, traced or stored in transcripts.
 * Regex-based so it works with no external service; the AI service (Presidio) can add NER on top.
 */
export interface Finding {
  type: string;
  start: number;
  end: number;
}

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

// Verhoeff check digit (UIDAI's Aadhaar checksum), so random 12-digit runs aren't reported as Aadhaar.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export const verhoeffValid = (digits: string): boolean => {
  let check = 0;
  for (let i = 0; i < digits.length; i++) {
    check = VERHOEFF_D[check]![VERHOEFF_P[i % 8]![Number(digits[digits.length - 1 - i])]!]!;
  }
  return check === 0;
};

interface Rule {
  type: string;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters: longer, more specific patterns run first so they win overlaps.
// Every pattern can only start at a run boundary, so scanning stays linear (no ReDoS on long input).
const RULES: Rule[] = [
  { type: 'EMAIL', re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    type: 'CARD',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { type: 'PHONE', re: /(?<!\d)(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g },
  {
    type: 'AADHAAR',
    re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    accept: (m) => verhoeffValid(m.replace(/\D/g, '')),
  },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'UPI', re: /\b[A-Za-z0-9._-]{2,256}@(?:ok)?[a-z]{2,64}\b/g },
  { type: 'PINCODE', re: /\b(?:pin(?:\s?code)?|postal code)\s*(?:[:#-]\s*)?[1-9]\d{5}\b/gi },
];

// Identifiers, not personal data: digit runs inside a UUID can look like a phone or Aadhaar number.
const UUID = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;

const overlaps = (spans: readonly { start: number; end: number }[], start: number, end: number): boolean =>
  spans.some((f) => start < f.end && end > f.start);

export function findPii(text: string): Finding[] {
  const ids = [...text.matchAll(UUID)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const found: Finding[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (rule.accept && !rule.accept(m[0])) continue;
      if (overlaps(ids, start, end) || overlaps(found, start, end)) continue;
      found.push({ type: rule.type, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function redact(text: string): string {
  const findings = findPii(text);
  let out = '';
  let last = 0;
  for (const f of findings) {
    out += `${text.slice(last, f.start)}[${f.type}]`;
    last = f.end;
  }
  return out + text.slice(last);
}

/** Recursively redacts strings inside JSON-like values (for audit payloads and traces). */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, depth + 1)]));
  }
  return value;
}
