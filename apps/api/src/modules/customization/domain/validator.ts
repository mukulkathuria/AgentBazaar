import type { CustomizationIssue, CustomizationIssueCode, CustomizationValues, TextFieldSpec } from '@agentbazaar/contracts';
import { BLOCKED_WORDS, INJECTION_PATTERNS, REVIEW_WORDS, TRADEMARKS } from './wordlists.js';

type Severity = 'reject' | 'review';

interface Finding {
  code: CustomizationIssueCode;
  severity: Severity;
  message: string;
}

/** Specification pattern: each rule inspects one field value and reports at most one finding. */
interface Spec {
  check(value: string, field: TextFieldSpec): Finding | null;
}

// eslint-disable-next-line no-control-regex -- detecting control characters is the purpose
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
const ZERO_WIDTH = /[\u200B\u2060\uFEFF\u00AD\u180E]/u;
const JOINERS = /[\u200C\u200D]/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3|\uFE0F/u;
const LOOKALIKE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;
const FULLWIDTH = /[！-～]/u;
const MARKUP = /<[^>]*>|&#?[a-z0-9]+;|javascript:|data:|\{\{|\}\}|\$\{|\[\[|\]\]|`/i;
const LATIN_ALLOWED = /^[\p{Script=Latin}\p{Nd}\p{Zs}.,!?'"&()\-:;/+#@₹]*$/u;
const LATIN_DEVANAGARI_ALLOWED = /^[\p{Script=Latin}\p{Script=Devanagari}\p{Nd}\p{Zs}.,!?'"&()\-:;/+#@₹।॥\u200C\u200D]*$/u;
const DEVANAGARI = /\p{Script=Devanagari}/u;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** Length as a person sees it: Devanagari conjuncts and combining marks count once. */
export const graphemeLength = (s: string): number => [...segmenter.segment(s)].length;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i' };

/** Lower-cased, leetspeak-folded, separator-free form used for word-list matching. */
export function skeleton(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const containsWord = (sk: string, words: readonly string[]): string | undefined => words.find((w) => sk.includes(w));

const SPECS: Spec[] = [
  { check: (v) => (CONTROL.test(v) ? { code: 'control_chars', severity: 'reject', message: 'Remove control characters' } : null) },
  { check: (v) => (BIDI.test(v) ? { code: 'bidi_override', severity: 'reject', message: 'Text direction override characters are not allowed' } : null) },
  {
    check: (v, f) =>
      ZERO_WIDTH.test(v) || (JOINERS.test(v) && !(f.script === 'latin_devanagari' && DEVANAGARI.test(v)))
        ? { code: 'zero_width', severity: 'reject', message: 'Invisible characters are not allowed' }
        : null,
  },
  { check: (v, f) => (!f.allowEmoji && EMOJI.test(v) ? { code: 'emoji', severity: 'reject', message: 'Emoji cannot be printed on this item' } : null) },
  {
    check: (v) =>
      LOOKALIKE_SCRIPTS.test(v) || FULLWIDTH.test(v)
        ? { code: 'mixed_script', severity: 'reject', message: 'Look-alike letters from other scripts are not allowed' }
        : null,
  },
  { check: (v) => (MARKUP.test(v) ? { code: 'markup', severity: 'reject', message: 'Markup and code are not allowed' } : null) },
  {
    check: (v, f) =>
      !(f.script === 'latin' ? LATIN_ALLOWED : LATIN_DEVANAGARI_ALLOWED).test(v)
        ? { code: 'charset', severity: 'reject', message: f.script === 'latin' ? 'Use English letters, digits and basic punctuation' : 'Use English or Hindi letters, digits and basic punctuation' }
        : null,
  },
  {
    check: (v) =>
      INJECTION_PATTERNS.some((re) => re.test(v))
        ? { code: 'prompt_injection', severity: 'reject', message: 'This text looks like an instruction to a system and cannot be printed' }
        : null,
  },
  {
    check: (v) =>
      containsWord(skeleton(v), BLOCKED_WORDS) ? { code: 'blocked_word', severity: 'reject', message: 'This text contains words we cannot print' } : null,
  },
  {
    check: (v) =>
      containsWord(skeleton(v), REVIEW_WORDS) ? { code: 'blocked_word', severity: 'review', message: 'A person will review this text before printing' } : null,
  },
  {
    check: (v) =>
      containsWord(skeleton(v), TRADEMARKS) ? { code: 'trademark', severity: 'review', message: 'Brand names need a licence check before printing' } : null,
  },
];

export interface DesignRules {
  allowedDesignIds: ReadonlySet<string>;
  designRequired: boolean;
}

export interface ValidationOutcome {
  verdict: 'approved' | 'rejected' | 'needs_review';
  issues: CustomizationIssue[];
  /** Normalised values (NFC, trimmed, collapsed spaces). Null when rejected. */
  normalized: CustomizationValues | null;
  flagged: { field: string; text: string; flags: string[] }[];
}

function lengthIssue(f: TextFieldSpec, v: string): CustomizationIssue | null {
  const len = graphemeLength(v);
  if (len > f.maxLength) return { field: f.key, code: 'too_long', message: `${f.label} can be at most ${f.maxLength} characters` };
  if (len < f.minLength) return { field: f.key, code: 'too_short', message: `${f.label} needs at least ${f.minLength} characters` };
  return null;
}

function unknownFieldIssues(fields: readonly TextFieldSpec[], values: CustomizationValues): CustomizationIssue[] {
  const known = new Set(fields.map((f) => f.key));
  return Object.keys(values.text)
    .filter((key) => !known.has(key))
    .map((key): CustomizationIssue => ({ field: key, code: 'unknown_field', message: `"${key}" is not a customizable field` }));
}

function designIssues(design: DesignRules, values: CustomizationValues): CustomizationIssue[] {
  const out: CustomizationIssue[] = [];
  if (values.designId !== undefined && !design.allowedDesignIds.has(values.designId)) {
    out.push({ field: 'designId', code: 'design_not_allowed', message: 'That design is not available for this product' });
  }
  if (design.designRequired && values.designId === undefined) {
    out.push({ field: 'designId', code: 'design_required', message: 'Pick a design from the catalogue' });
  }
  return out;
}

const normalise = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();

export function validateValues(fields: readonly TextFieldSpec[], design: DesignRules, values: CustomizationValues): ValidationOutcome {
  const issues = unknownFieldIssues(fields, values);
  const flagged: ValidationOutcome['flagged'] = [];
  const text: Record<string, string> = {};
  let reject = issues.length > 0;
  let review = false;

  for (const f of fields) {
    const raw = values.text[f.key];
    const v = raw === undefined ? '' : normalise(raw);
    if (!v) {
      if (f.required) {
        issues.push({ field: f.key, code: 'required', message: `${f.label} is required` });
        reject = true;
      }
      continue;
    }
    // Length problems do not stop the scan: security findings are always reported too.
    const lengthProblem = lengthIssue(f, v);
    if (lengthProblem) {
      issues.push(lengthProblem);
      reject = true;
    }
    const findings = SPECS.map((s) => s.check(raw ?? v, f)).filter((x): x is Finding => x !== null);
    for (const fd of findings) issues.push({ field: f.key, code: fd.code, message: fd.message });
    if (findings.some((fd) => fd.severity === 'reject')) reject = true;
    else if (findings.length) {
      review = true;
      flagged.push({ field: f.key, text: v, flags: findings.map((fd) => fd.code) });
    }
    text[f.key] = v;
  }
  const designProblems = designIssues(design, values);
  if (designProblems.length) {
    issues.push(...designProblems);
    reject = true;
  }
  const verdict = reject ? 'rejected' : review ? 'needs_review' : 'approved';
  return {
    verdict,
    issues,
    normalized: reject ? null : { text, ...(values.designId ? { designId: values.designId } : {}) },
    flagged: reject ? [] : flagged,
  };
}
