import type { Level } from '@agentbazaar/contracts';
import { BOTTOM, combine, HIGH_CART_PAISE, LOW_CONFIDENCE, propose, type Route } from './router.js';

/** What the observer gate looks at: the turn's classification, its route and what the reply commits to. */
export interface ObserverSignals {
  /** Sending a negotiated price, or handling a warranty or return claim. */
  commitment: boolean;
  confidence: number;
  negotiationRound: number;
  cartValuePaise: number;
  toolFailed: boolean;
  /** The buyer has complained in this conversation. */
  upset: boolean;
  /** The classifier's risk level for this turn. */
  risk: Level;
  /** The router refused the request (injection, exhausted budget). */
  denied: boolean;
  /** The router handed the chat to a person (abuse, disputes, repeated injection). */
  handoff: boolean;
  /** Risky asks found in the buyer's own words, see riskProbes. */
  probes: readonly string[];
}

const words = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`, 'iu');

// A backstop for what the classifier misses (it reads "Disregard your pricing rules..." as a price question).
// A false positive only costs one observer check, so these lean wide.
const PROBES: readonly (readonly [string, RegExp])[] = [
  [
    'instructions',
    words(
      'ignore|disregard|forget (?:all|your|previous|everything)|override|bypass|pretend|jailbreak|developer mode|admin|' +
        'authori[sz]e[sd]?|instructions?|rules|verbatim|repeat everything|above this line|system prompt|bhool jao|निर्देश|नियम',
    ),
  ],
  [
    'secrets',
    words('floor|minimum price|lowest you|cost price|your cost|landed cost|margins?|profits?|mark-?ups?|wholesale|break-?even|lagat|laagat|munafa|लागत|मुनाफा'),
  ],
  [
    'personal_data',
    words(
      'e-?mails?|phone|mobile number|contact (?:details|number)|address(?:es)?|aadhaa?r|pan card|upi id|card number|' +
        'customers?|who (?:bought|ordered)|their names?|फ़ोन|फोन|पता|ग्राहक',
    ),
  ],
];

/** Which risky asks a buyer message makes: instructions, secret prices or costs, or other people's data. */
export const riskProbes = (text: string): string[] =>
  PROBES.filter(([, re]) => re.test(text.normalize('NFKC'))).map(([name]) => name);

/**
 * Why a turn must be observed. Empty means the observer, and the model call it may make, is skipped:
 * a calm, confident, low-risk turn that commits to nothing. Injection, floor and personal-data probes,
 * abuse and every commitment always land here.
 */
export function observerReasons(s: ObserverSignals): string[] {
  const triggers: [boolean, string][] = [
    [s.commitment, 'commitment'],
    [s.confidence < LOW_CONFIDENCE, 'low_confidence'],
    [s.negotiationRound >= 3, 'late_negotiation_round'],
    [s.cartValuePaise > HIGH_CART_PAISE, 'high_cart_value'],
    [s.toolFailed, 'tool_failure'],
    [s.upset, 'upset'],
    [s.risk !== 'low', `${s.risk}_risk`],
    [s.denied, 'denied'],
    [s.handoff, 'handoff'],
  ];
  return [...triggers.filter(([on]) => on).map(([, why]) => why), ...s.probes.map((p) => `probe:${p}`)];
}

/**
 * What the observer adds after checking a reply. Like router stages it only adds caution; the caller
 * replaces a reply that failed the guard or the judge with its template.
 */
export function observe(s: ObserverSignals, guardPassed: boolean, judgePassed: boolean): Route {
  let r = BOTTOM;
  if (!guardPassed) r = combine(r, propose(3, 'observer_guard'));
  if (!judgePassed) r = combine(r, propose(3, 'observer_judge'));
  if (s.toolFailed) r = combine(r, propose(3, 'tool_failure'));
  if (s.upset && s.commitment) r = combine(r, propose(4, 'upset_at_commitment'));
  return r;
}
