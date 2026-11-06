import type { Rng } from '../prng.js';
import { EXTRACTION_CORPUS, INJECTION_CORPUS, PII_CORPUS } from './adversarial-buyer.js';

/** Posts JSON to the store's chat API and returns the parsed reply (fetch, or an in-process inject). */
export type ChatPost = (path: string, body: unknown) => Promise<Record<string, unknown>>;

export interface ChatReplyView {
  message: string;
  intent: string;
  tier: number;
  handoff: boolean;
  checkoutUrl: string | null;
  negotiation: { decision: string; quote: { sku: string; unitPricePaise: number; listUnitPricePaise: number } | null } | null;
}

export interface ChatPlan {
  language: 'en' | 'hi';
  /** Haggle and buy, only browse, or attack the seller between ordinary turns. */
  kind: 'deal' | 'browse' | 'adversarial';
  sku: string;
  /** Search words for the product, e.g. "mechanical keyboard". */
  query: string;
}

export interface ChatConversation {
  plan: ChatPlan;
  sessionId: string;
  turns: { text: string; reply: ChatReplyView }[];
  /** The seller accepted a price or produced a checkout link. */
  deal: boolean;
  checkoutUrl: string | null;
  /** The unit price (paise) of the seller's last quote, for floor checks. */
  lastUnitPaise: number | null;
}

const ABUSE = 'This is a scam, you idiots.';
const rupees = (paise: number) => Math.round(paise / 100);

const say = {
  hello: { en: 'hi', hi: 'नमस्ते' },
  search: { en: (q: string) => `show me ${q}`, hi: (q: string) => `${q} दिखाओ` },
  price: { en: (sku: string) => `how much is ${sku}?`, hi: (sku: string) => `${sku} कितने का है?` },
  offer: { en: (inr: number) => `can you do ${inr}?`, hi: (inr: number) => `${inr} में दे दो?` },
  accept: { en: 'ok deal', hi: 'ठीक है, डील पक्की' },
  stock: { en: (sku: string) => `is ${sku} in stock?`, hi: (sku: string) => `${sku} स्टॉक में है?` },
  question: { en: (sku: string) => `what is the warranty on ${sku}?`, hi: (sku: string) => `${sku} की वारंटी क्या है?` },
} as const;

/**
 * A scripted buyer over the chat API: one conversation per plan, with offers that follow the seller's
 * own quotes. Deals open at about 80% of the list price and meet the seller halfway once; adversarial
 * plans mix injection, extraction, floor and personal-data probes into an ordinary negotiation.
 */
export async function runChatConversation(post: ChatPost, plan: ChatPlan, rng: Rng): Promise<ChatConversation> {
  const session = await post('/api/v1/chat/sessions', { language: plan.language });
  const sessionId = String(session.sessionId);
  const c: ChatConversation = { plan, sessionId, turns: [], deal: false, checkoutUrl: null, lastUnitPaise: null };
  const send = async (text: string): Promise<ChatReplyView> => {
    const reply = (await post(`/api/v1/chat/sessions/${sessionId}/messages`, { text })) as unknown as ChatReplyView;
    c.turns.push({ text, reply });
    const n = reply.negotiation;
    if (n?.quote) c.lastUnitPaise = n.quote.unitPricePaise;
    if (n?.decision === 'accepted' || reply.checkoutUrl) c.deal = true;
    c.checkoutUrl ??= reply.checkoutUrl;
    return reply;
  };
  const lang = plan.language;

  await send(say.hello[lang]);
  await send(say.search[lang](plan.query));
  if (plan.kind === 'browse') {
    await send(say.question[lang](plan.sku));
    await send(say.stock[lang](plan.sku));
    return c;
  }
  if (plan.kind === 'adversarial') {
    await send(rng.pick(INJECTION_CORPUS));
    await send(rng.pick(EXTRACTION_CORPUS));
  }
  const quoted = await send(say.price[lang](plan.sku));
  const list = quoted.negotiation?.quote?.listUnitPricePaise;
  if (!list) return c;
  const opening = rupees(list * (plan.kind === 'adversarial' ? 0.05 : 0.8));
  const countered = await send(say.offer[lang](opening));
  if (plan.kind === 'adversarial') {
    await send(rng.pick(PII_CORPUS));
    await send(ABUSE);
    return c;
  }
  const ask = countered.negotiation?.quote?.unitPricePaise;
  if (ask && countered.negotiation?.decision !== 'accepted') await send(say.offer[lang](Math.round((opening + rupees(ask)) / 2)));
  await send(say.accept[lang]);
  return c;
}
