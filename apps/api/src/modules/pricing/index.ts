export { PricingModule } from './pricing.module.js';
export { NegotiationService, type AcceptedQuote, type Channel } from './application/negotiation.service.js';
export { describeOutcome, type OutcomeFacts } from './application/messages.js';
export { computeLadder, askAt, decideOffer, guardedFloor, volumeAlternatives, type BandPolicy, type Ladder } from './domain/policy.js';
export { negotiationStats, pendingApprovals } from './application/stats.js';
