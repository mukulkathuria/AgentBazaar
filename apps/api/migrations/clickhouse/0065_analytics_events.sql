-- ClickHouse (ANALYTICS_ADAPTER=clickhouse): analytics events written by the analytics-clickhouse outbox consumer.
-- Monthly partitions; TTL drops rows 13 months after the event. The outbox event id is the dedupe key: a replayed
-- event repeats (kind, at, id), so insert deduplication skips it and ReplacingMergeTree collapses any copy that
-- slips past the window. Dashboards read with FINAL, so counts are exact even before merges.
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID,
  kind LowCardinality(String),
  ref Nullable(String),
  data Map(String, String),
  at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (kind, at, id)
TTL toDateTime(at) + INTERVAL 13 MONTH DELETE
SETTINGS non_replicated_deduplication_window = 1000;
