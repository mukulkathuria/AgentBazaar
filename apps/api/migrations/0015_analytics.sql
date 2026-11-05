-- Tracked events for GEO measurement and the Phase 4 ops agents: searches, zero-result searches,
-- views, add-to-cart, negotiation outcomes, return reasons, AI crawler hits and AI referrals.
CREATE TABLE analytics_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  ref text,
  data jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_kind_at_idx ON analytics_events (kind, at DESC);
