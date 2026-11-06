-- Range-partition the append-only event logs by UTC month (ADR 0013), so old months can be archived and dropped
-- as whole partitions instead of deleted row by row. Each table is renamed, recreated as a partitioned table with
-- the same columns, defaults, checks, identity columns and indexes, given partitions for every month it holds
-- plus three months ahead, copied and dropped. Keys must include the partition key, so deduplication on
-- (consumer, event_id) and (provider, event_id) moved to a per-key advisory lock in code (outbox.ts, payments.module.ts).
-- Later migrations may already have run on a database that tracks main (0060 and 0080 add a column and an index),
-- so nothing here assumes the original column or index list.
-- Each table stays locked until the migration commits; docs/benchmarks/data-scale.md gives the time per million rows.
CREATE FUNCTION pg_temp.partition_by_month(tbl text, key text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  old text := tbl || '_unpartitioned';
  indexes text[];
  def text;
  first_month date;
  col record;
  seq text;
BEGIN
  -- Indexes that are not keys, as written for this table name, to recreate on the partitioned table.
  SELECT coalesce(array_agg(pg_get_indexdef(i.indexrelid)), '{}') INTO indexes FROM pg_index i
    WHERE i.indrelid = tbl::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid);
  EXECUTE format('ALTER TABLE %I RENAME TO %I', tbl, old);
  EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING IDENTITY) PARTITION BY RANGE (%I)',
    tbl, old, key);
  EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', tbl || '_default', tbl);
  EXECUTE format('SELECT (min(%I) AT TIME ZONE ''UTC'')::date FROM %I', key, old) INTO first_month;
  PERFORM ensure_month_partitions(tbl::regclass, 3, first_month);
  EXECUTE format('INSERT INTO %I OVERRIDING SYSTEM VALUE SELECT * FROM %I', tbl, old);
  -- Ids continue where they stopped: a serial's sequence moves to the new column; an identity column got a new
  -- sequence, which starts where the old one stopped.
  FOR col IN SELECT attname, attidentity FROM pg_attribute WHERE attrelid = old::regclass AND attnum > 0 AND NOT attisdropped LOOP
    seq := pg_get_serial_sequence(old, col.attname);
    IF seq IS NOT NULL AND col.attidentity = '' THEN
      EXECUTE format('ALTER SEQUENCE %s OWNED BY %I.%I', seq, tbl, col.attname);
    ELSIF seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, last_value, is_called) FROM %s', pg_get_serial_sequence(tbl, col.attname), seq);
    END IF;
  END LOOP;
  EXECUTE format('DROP TABLE %I', old);
  FOREACH def IN ARRAY indexes LOOP
    EXECUTE def;
  END LOOP;
END $$;

-- The (order_id, id) index becomes (order_id): an order's few events then share one deduplicated index entry.
DROP INDEX order_events_order_idx;
SELECT pg_temp.partition_by_month('order_events', 'created_at');
ALTER TABLE order_events ADD PRIMARY KEY (id, created_at);
CREATE INDEX order_events_order_idx ON order_events (order_id);
ALTER TABLE order_events ADD FOREIGN KEY (order_id) REFERENCES orders (id);
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

SELECT pg_temp.partition_by_month('outbox_events', 'created_at');
ALTER TABLE outbox_events ADD PRIMARY KEY (id, created_at);

SELECT pg_temp.partition_by_month('processed_events', 'processed_at');
ALTER TABLE processed_events ADD PRIMARY KEY (consumer, event_id, processed_at);

SELECT pg_temp.partition_by_month('webhook_events', 'received_at');
ALTER TABLE webhook_events ADD PRIMARY KEY (provider, event_id, received_at);

SELECT pg_temp.partition_by_month('analytics_events', 'at');
ALTER TABLE analytics_events ADD PRIMARY KEY (id, at);

SELECT pg_temp.partition_by_month('audit_log', 'at');
ALTER TABLE audit_log ADD PRIMARY KEY (id, at);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

SELECT pg_temp.partition_by_month('llm_traces', 'at');
ALTER TABLE llm_traces ADD PRIMARY KEY (id, at);
CREATE TRIGGER llm_traces_append_only BEFORE UPDATE OR DELETE ON llm_traces FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP FUNCTION pg_temp.partition_by_month(text, text);
