/**
 * Moderation word lists for customization text. Matching happens on a normalised "skeleton"
 * (lower case, leetspeak folded, separators removed), so "s.h.1.t" still matches.
 * Lists are intentionally short and editable; operators extend them for their market.
 */
export const BLOCKED_WORDS: readonly string[] = [
  'fuck', 'shit', 'bitch', 'bastard', 'cunt', 'asshole', 'dickhead', 'motherfucker', 'whore', 'slut',
  'chutiya', 'madarchod', 'bhenchod', 'behenchod', 'bhosdike', 'gandu', 'randi', 'harami', 'lauda', 'lavda',
];

/** Words that are fine in many contexts but need a human look before printing. */
export const REVIEW_WORDS: readonly string[] = ['kill', 'hate', 'drugs', 'weed', 'bomb', 'gun', 'nazi', 'saala', 'kamina'];

/** Third-party marks we must not print without a licence. Flagged for human review. */
export const TRADEMARKS: readonly string[] = [
  'nike', 'adidas', 'puma', 'cocacola', 'pepsi', 'disney', 'marvel', 'pokemon', 'apple', 'google', 'microsoft',
  'ferrari', 'rolex', 'gucci', 'louisvuitton', 'ipl', 'bcci', 'fifa', 'starbucks', 'mcdonalds',
];

/** Prompt-injection phrasings in English and Hinglish. Customization text is data, never instructions. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  /(system|developer)\s+(prompt|message|instructions?)/i,
  /\byou\s+are\s+now\b/i,
  /\b(disregard|override|bypass)\b.{0,30}\b(rules?|instructions?|policy|polic(y|ies)|guardrails?)/i,
  /\b(reveal|show|print|tell)\b.{0,30}\b(prompt|instructions?|floor|margin|cost\s*price)/i,
  /\bjailbreak\b|\bDAN\s+mode\b|\bdeveloper\s+mode\b/i,
  /\bact\s+as\s+(an?\s+)?(admin|seller|system|assistant)\b/i,
  /pichl[ei].{0,25}(instructions?|baat|rules?).{0,15}(bhool|ignore|bhul)/i,
  /\bnew\s+instructions?\s*:/i,
];
