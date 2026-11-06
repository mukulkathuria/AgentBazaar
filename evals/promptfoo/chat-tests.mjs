// Chat test cases. Core (every push and pull request): golden conversations in English, Hindi and Hinglish
// plus a sample of attacks. Full (nightly, EVAL_SET=full): every prompt of the testkit attack corpora too,
// each asked after a real quote so "this" and "the floor" have something to refer to.
import { EXTRACTION_CORPUS, INJECTION_CORPUS, PII_CORPUS } from '../../packages/testkit/dist/index.js';

const EXPECTED = { type: 'javascript', value: 'file://policy.mjs:expected' };
const NO_LEAK = { type: 'javascript', value: 'file://policy.mjs:noLeak' };

const turn = (conversation, language, message, expect, extra = []) => ({
  description: `${conversation}: ${message}`,
  vars: { conversation, language, message, expect },
  assert: [EXPECTED, ...extra],
});

const GOLDEN = [
  turn('haggle-en', 'en', 'show me mechanical keyboards under 6000', {
    intent: 'search',
    products: true,
    maxPricePaise: 600_000,
  }),
  turn('haggle-en', 'en', 'how much is THOCK-TK87-RED?', {
    intent: 'ask_price',
    decision: 'quoted',
    quote: 'list',
  }),
  turn('haggle-en', 'en', 'can you do 4000', {
    intent: 'make_offer',
    decision: 'countered',
    quote: 'discounted',
    notContains: ['4,000', '4000'],
  }),
  turn('haggle-en', 'en', 'Amazon sells it for ₹3000, match it', {
    intent: 'competitor_claim',
    noNegotiation: true,
    notContains: ['3,000', '3000'],
  }),
  turn('haggle-en', 'en', 'ok deal', { intent: 'accept', checkout: true }),
  turn('haggle-hi', 'hi', 'THOCK-TK87-RED का दाम क्या है?', {
    intent: 'ask_price',
    decision: 'quoted',
    quote: 'list',
    hindi: true,
  }),
  turn('haggle-hi', 'hi', '4000 में दे दो', {
    intent: 'make_offer',
    decision: 'countered',
    quote: 'discounted',
    hindi: true,
  }),
  turn('haggle-hi', 'hi', 'ठीक है, डील', { intent: 'accept', checkout: true, hindi: true }),
  turn('haggle-hinglish', 'en', 'mujhe keyboard dikhao', { intent: 'search', products: true }),
  turn('haggle-hinglish', 'en', 'THOCK-TK87-RED ka price kya hai', {
    intent: 'ask_price',
    decision: 'quoted',
    quote: 'list',
  }),
  turn('haggle-hinglish', 'en', '4000 mein de do', {
    intent: 'make_offer',
    decision: 'countered',
    quote: 'discounted',
  }),
];

/** A quote first, then the attack in the same conversation: the seller must not give in or leak. */
const attack = (id, message, expect = {}) => [
  turn(id, 'en', 'how much is THOCK-TK87-RED?', { intent: 'ask_price', decision: 'quoted' }),
  turn(id, 'en', message, { notAccepted: true, ...expect }, [NO_LEAK]),
];
const injection = { intent: 'injection_attempt' };

const CORE_ATTACKS = [
  ...attack('injection-en', INJECTION_CORPUS[0], injection),
  ...attack('injection-hinglish', INJECTION_CORPUS[3], injection),
  ...attack('injection-hi', INJECTION_CORPUS[4], injection),
  ...attack('extraction-system-prompt', EXTRACTION_CORPUS[0], injection),
  ...attack('extraction-floor', EXTRACTION_CORPUS[2], injection),
  ...attack('pii-en', PII_CORPUS[0]),
  ...attack('pii-hinglish', PII_CORPUS[3]),
];

const FULL_ATTACKS = [
  ...INJECTION_CORPUS.flatMap((m, i) => attack(`corpus-injection-${i}`, m)),
  ...EXTRACTION_CORPUS.flatMap((m, i) => attack(`corpus-extraction-${i}`, m)),
  ...PII_CORPUS.flatMap((m, i) => attack(`corpus-pii-${i}`, m)),
];

export default async function chatTests() {
  return [...GOLDEN, ...CORE_ATTACKS, ...(process.env.EVAL_SET === 'full' ? FULL_ATTACKS : [])];
}
