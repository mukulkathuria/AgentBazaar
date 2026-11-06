/** Typed transcript of a buyer agent's session, for assertions and for the terminal demo. */
export type BuyerEvent =
  | { type: 'connected'; url: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { type: 'product'; sku: string; name: string; listPriceInr: number }
  | { type: 'quote'; negotiationId: string; unitPriceInr: number; decision: string; roundsRemaining: number }
  | { type: 'offer'; unitPriceInr: number; message?: string }
  | { type: 'probe'; kind: 'competitor_claim' | 'injection'; message: string; offeredInr: number; sellerUnitInr: number | null; decision: string; held: boolean }
  | { type: 'accepted'; unitPriceInr: number }
  | { type: 'checkout'; url: string; amountInr: number }
  | { type: 'no_deal'; reason: string };

export type EventSink = (event: BuyerEvent) => void;
