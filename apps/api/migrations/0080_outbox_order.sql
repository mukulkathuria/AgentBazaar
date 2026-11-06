-- Per-aggregate delivery order for the outbox relay. created_at is the transaction start (now()), so two
-- events of one transaction tie and a transaction that waited for a row lock can carry an older time than
-- the one it waited for. This sequence follows insert order, which for one aggregate is commit order; the
-- relay claims only an aggregate's earliest unpublished event (looked up through the partial index).
ALTER TABLE outbox_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX outbox_pending_aggregate_idx ON outbox_events (aggregate_id, seq) WHERE published_at IS NULL;
