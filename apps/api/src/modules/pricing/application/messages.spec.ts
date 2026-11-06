import { formatInr, type Language } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { describeOutcome, type OutcomeFacts } from './messages.js';

const EXPIRES = new Date('2026-11-05T10:00:00.000Z');
const ist = (lang: Language) =>
  EXPIRES.toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const base: OutcomeFacts = {
  decision: 'quoted',
  productName: 'VoltEdge Keyboard',
  quantity: 2,
  unitPaise: 549_900,
  expiresAt: EXPIRES,
  alternatives: [],
  reasonCodes: [],
};
const trade = { quantity: 5, unitPricePaise: 520_000, reason: 'volume' as const };
const say = (f: Partial<OutcomeFacts>, lang?: Language) => describeOutcome({ ...base, ...f }, lang);

describe('@lite negotiation wording (every number comes from the decision)', () => {
  const unit = formatInr(549_900, 'en');
  const total = formatInr(1_099_800, 'en');

  it('shows the expiry as a time in India (10:00 UTC is 15:30 IST)', () => {
    expect(say({})).toContain('03:30');
    expect(say({}, 'hi')).toContain('03:30');
  });

  it('words each English outcome with the policy numbers', () => {
    expect(say({})).toBe(`2 × VoltEdge Keyboard: ${unit} each (${total} total). This quote is valid until ${ist('en')}.`);
    expect(say({ decision: 'countered', reasonCodes: ['counter'] })).toBe(`I can do: ${unit} each.`);
    expect(say({ decision: 'countered', reasonCodes: ['final_offer'] })).toBe(`That's my best and final price: ${unit} each.`);
    expect(say({ decision: 'accepted' })).toBe(`Deal! 2 × VoltEdge Keyboard at ${unit} each (${total} total). Check out before ${ist('en')}.`);
    expect(say({ decision: 'rejected', reasonCodes: ['fixed_price'] })).toBe(`This item has a fixed price of ${unit} each.`);
    expect(say({ decision: 'rejected', reasonCodes: ['rounds_exhausted'] })).toBe(
      `I can't go below ${unit} each. That offer stays open until ${ist('en')}.`,
    );
    expect(say({ decision: 'pending_approval' })).toBe(
      "That's a big discount, so I've asked a manager to approve it. You'll hear back shortly.",
    );
  });

  it('offers the first volume trade where a counter or quote leaves room for one', () => {
    const offer = ` Take 5 and I can do ${formatInr(520_000, 'en')} each.`;
    expect(say({ alternatives: [trade, { ...trade, quantity: 10 }] }).endsWith(offer)).toBe(true);
    expect(say({ decision: 'countered', alternatives: [trade] })).toBe(`I can do: ${unit} each.${offer}`);
    expect(say({ decision: 'rejected', reasonCodes: ['fixed_price'], alternatives: [trade] })).toBe(
      `This item has a fixed price of ${unit} each.${offer}`,
    );
  });

  it('words each Hindi outcome with Hindi number formatting', () => {
    const hu = formatInr(549_900, 'hi');
    const ht = formatInr(1_099_800, 'hi');
    const offer = ` 5 पीस लें तो ${formatInr(520_000, 'hi')} प्रति पीस।`;
    expect(say({ alternatives: [trade] }, 'hi')).toBe(`2 × VoltEdge Keyboard: ${hu} प्रति पीस (कुल ${ht})। यह कोट ${ist('hi')} तक मान्य है।${offer}`);
    expect(say({ decision: 'countered' }, 'hi')).toBe(`मैं दे सकता हूँ: ${hu} प्रति पीस।`);
    expect(say({ decision: 'countered', reasonCodes: ['final_offer'], alternatives: [trade] }, 'hi')).toBe(
      `यह मेरी आख़िरी कीमत है: ${hu} प्रति पीस।${offer}`,
    );
    expect(say({ decision: 'accepted' }, 'hi')).toBe(`डील पक्की! 2 × VoltEdge Keyboard, ${hu} प्रति पीस (कुल ${ht})। ${ist('hi')} से पहले चेकआउट करें।`);
    expect(say({ decision: 'rejected', reasonCodes: ['fixed_price'] }, 'hi')).toBe(`इसकी कीमत तय है: ${hu} प्रति पीस।`);
    expect(say({ decision: 'rejected' }, 'hi')).toBe(`मैं ${hu} से कम नहीं कर सकता। यह ऑफ़र ${ist('hi')} तक खुला है।`);
    expect(say({ decision: 'pending_approval' }, 'hi')).toBe('यह बड़ी छूट है, इसलिए मैंने मैनेजर से मंज़ूरी माँगी है। जल्द जवाब मिलेगा।');
  });

  it('defaults to English', () => {
    expect(describeOutcome(base)).toBe(describeOutcome(base, 'en'));
  });
});
