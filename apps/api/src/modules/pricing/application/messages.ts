import { formatInr, type Language, type NegotiationDecision, type TradeAlternative } from '@agentbazaar/contracts';

export interface OutcomeFacts {
  decision: NegotiationDecision;
  productName: string;
  quantity: number;
  unitPaise: number;
  expiresAt: Date;
  alternatives: readonly TradeAlternative[];
  reasonCodes: readonly string[];
}

const time = (d: Date, lang: Language) =>
  d.toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

function trades(f: OutcomeFacts, lang: Language): string {
  const a = f.alternatives[0];
  if (!a) return '';
  const unit = formatInr(a.unitPricePaise, lang);
  return lang === 'hi' ? ` ${a.quantity} पीस लें तो ${unit} प्रति पीस।` : ` Take ${a.quantity} and I can do ${unit} each.`;
}

/** Formatted amounts and time shared by both languages. */
interface Wording {
  unit: string;
  total: string;
  until: string;
  final: boolean;
}

function hindi(f: OutcomeFacts, { unit, total, until, final }: Wording): string {
  switch (f.decision) {
    case 'quoted':
      return `${f.quantity} × ${f.productName}: ${unit} प्रति पीस (कुल ${total})। यह कोट ${until} तक मान्य है।${trades(f, 'hi')}`;
    case 'countered':
      return `${final ? 'यह मेरी आख़िरी कीमत है' : 'मैं दे सकता हूँ'}: ${unit} प्रति पीस।${trades(f, 'hi')}`;
    case 'accepted':
      return `डील पक्की! ${f.quantity} × ${f.productName}, ${unit} प्रति पीस (कुल ${total})। ${until} से पहले चेकआउट करें।`;
    case 'rejected':
      return f.reasonCodes.includes('fixed_price')
        ? `इसकी कीमत तय है: ${unit} प्रति पीस।${trades(f, 'hi')}`
        : `मैं ${unit} से कम नहीं कर सकता। यह ऑफ़र ${until} तक खुला है।`;
    case 'pending_approval':
      return 'यह बड़ी छूट है, इसलिए मैंने मैनेजर से मंज़ूरी माँगी है। जल्द जवाब मिलेगा।';
  }
}

function english(f: OutcomeFacts, { unit, total, until, final }: Wording): string {
  switch (f.decision) {
    case 'quoted':
      return `${f.quantity} × ${f.productName}: ${unit} each (${total} total). This quote is valid until ${until}.${trades(f, 'en')}`;
    case 'countered':
      return `${final ? "That's my best and final price" : 'I can do'}: ${unit} each.${trades(f, 'en')}`;
    case 'accepted':
      return `Deal! ${f.quantity} × ${f.productName} at ${unit} each (${total} total). Check out before ${until}.`;
    case 'rejected':
      return f.reasonCodes.includes('fixed_price')
        ? `This item has a fixed price of ${unit} each.${trades(f, 'en')}`
        : `I can't go below ${unit} each. That offer stays open until ${until}.`;
    case 'pending_approval':
      return "That's a big discount, so I've asked a manager to approve it. You'll hear back shortly.";
  }
}

/**
 * Template wording for every negotiation outcome. Every number comes from the policy decision.
 * The agent layer may rephrase this with an LLM, but a guard rejects any number not listed here.
 */
export function describeOutcome(f: OutcomeFacts, lang: Language = 'en'): string {
  const wording: Wording = {
    unit: formatInr(f.unitPaise, lang),
    total: formatInr(f.unitPaise * f.quantity, lang),
    until: time(f.expiresAt, lang),
    final: f.reasonCodes.includes('final_offer'),
  };
  return lang === 'hi' ? hindi(f, wording) : english(f, wording);
}
