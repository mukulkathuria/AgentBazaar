import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  costMicroInr,
  DEFAULT_PRICES,
  estimateTokens,
  exhausted,
  fits,
  observe,
  observerTriggered,
  type ObserverSignals,
  sampledForAudit,
  tokensRemaining,
} from './budget.js';

const budget = { tokens: 1000, costMicroInr: 50_000 };
const calm: ObserverSignals = { commitment: false, confidence: 0.9, negotiationRound: 0, cartValuePaise: 0, toolFailed: false, upset: false };

describe('session budgets', () => {
  it('lets a call through only while the estimate fits the token and cost caps', () => {
    expect(fits({ tokens: 0, costMicroInr: 0 }, budget, 1000)).toBe(true);
    expect(fits({ tokens: 400, costMicroInr: 0 }, budget, 601)).toBe(false);
    expect(fits({ tokens: 0, costMicroInr: 50_000 }, budget, 10)).toBe(false);
  });

  it('is exhausted at either cap and reports the tokens left', () => {
    expect(exhausted({ tokens: 999, costMicroInr: 0 }, budget)).toBe(false);
    expect(exhausted({ tokens: 1000, costMicroInr: 0 }, budget)).toBe(true);
    expect(exhausted({ tokens: 0, costMicroInr: 60_000 }, budget)).toBe(true);
    expect(tokensRemaining({ tokens: 250, costMicroInr: 0 }, budget)).toBe(750);
    expect(tokensRemaining({ tokens: 2500, costMicroInr: 0 }, budget)).toBe(0);
  });

  it('prices calls per model and treats unknown (self-hosted) models as free', () => {
    expect(costMicroInr(DEFAULT_PRICES, 'claude-haiku-5-5', 1000, 1000)).toBe(52_800);
    expect(costMicroInr(DEFAULT_PRICES, 'claude-sonnet-5-5', 500, 100)).toBe(176_000);
    expect(costMicroInr(DEFAULT_PRICES, 'llama3.1:8b', 5000, 5000)).toBe(0);
    expect(estimateTokens(400, 200)).toBe(300);
  });
});

describe('observer', () => {
  it('runs at commitment points and on risk triggers only', () => {
    expect(observerTriggered(calm)).toBe(false);
    expect(observerTriggered({ ...calm, commitment: true })).toBe(true);
    expect(observerTriggered({ ...calm, confidence: 0.4 })).toBe(true);
    expect(observerTriggered({ ...calm, negotiationRound: 3 })).toBe(true);
    expect(observerTriggered({ ...calm, cartValuePaise: 5_000_100 })).toBe(true);
    expect(observerTriggered({ ...calm, toolFailed: true })).toBe(true);
    expect(observerTriggered({ ...calm, upset: true })).toBe(true);
  });

  it('escalates on a failed re-check, tool failure, or an upset buyer making a claim', () => {
    expect(observe(calm, true).tier).toBe(0);
    expect(observe(calm, false).reasons.has('observer_guard')).toBe(true);
    expect(observe({ ...calm, toolFailed: true }, true).tier).toBe(3);
    expect(observe({ ...calm, upset: true, commitment: true }, true).tier).toBe(4);
  });

  it('samples about 5% of conversations for audit, deterministically', () => {
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    const rate = ids.filter((id) => sampledForAudit(id)).length / ids.length;
    expect(rate).toBeGreaterThan(0.04);
    expect(rate).toBeLessThan(0.06);
    expect(sampledForAudit(ids[0]!)).toBe(sampledForAudit(ids[0]!));
  });
});
