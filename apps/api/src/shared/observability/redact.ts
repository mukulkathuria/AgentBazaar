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

interface Rule {
  type: string;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters: longer, more specific patterns run first so they win overlaps.
const RULES: Rule[] = [
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    type: 'CARD',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { type: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: 'PHONE', re: /(?:\+91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'UPI', re: /\b[A-Za-z0-9._-]{2,256}@(?:ok)?[a-z]{2,64}\b/g },
  { type: 'PINCODE', re: /\b(?:pin(?:\s?code)?|postal code)\s*[:#-]?\s*[1-9]\d{5}\b/gi },
];

export function findPii(text: string): Finding[] {
  const found: Finding[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (rule.accept && !rule.accept(m[0])) continue;
      if (found.some((f) => start < f.end && end > f.start)) continue;
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
