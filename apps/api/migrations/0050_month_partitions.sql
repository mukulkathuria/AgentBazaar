-- Monthly range partitions for the append-only event logs (ADR 0013). A partition is named <table>_pYYYYMM and
-- covers one UTC calendar month; <table>_default catches rows that arrive before their month's partition exists.
-- Creates the partitions from `first_month` (default: this month) to `months_ahead` months ahead, and moves any
-- such stragglers out of the default partition into the new partition. Returns how many partitions it created.
CREATE OR REPLACE FUNCTION ensure_month_partitions(parent regclass, months_ahead int DEFAULT 3, first_month date DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date := coalesce(date_trunc('month', first_month)::date, this_month);
  def regclass := to_regclass(parent::text || '_default');
  key text;
  part text;
  lo timestamptz;
  hi timestamptz;
  stragglers boolean;
  created int := 0;
BEGIN
  SELECT a.attname INTO STRICT key FROM pg_partitioned_table p
    JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
    WHERE p.partrelid = parent;
  WHILE m <= this_month + make_interval(months => months_ahead) LOOP
    part := format('%s_p%s', parent::text, to_char(m, 'YYYYMM'));
    IF to_regclass(part) IS NULL THEN
      lo := m::timestamp AT TIME ZONE 'UTC';
      hi := (m + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      stragglers := false;
      IF def IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I >= $1 AND %I < $2)', def, key, key) INTO stragglers USING lo, hi;
      END IF;
      -- Postgres refuses a new partition while the default holds rows for its range. Detaching the default also
      -- drops its clone of the append-only trigger, so the rows can be moved and the default attached again.
      IF stragglers THEN
        EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', parent, def);
      END IF;
      EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', part, parent, lo, hi);
      IF stragglers THEN
        EXECUTE format('WITH moved AS (DELETE FROM %s WHERE %I >= $1 AND %I < $2 RETURNING *) INSERT INTO %s SELECT * FROM moved',
          def, key, key, parent) USING lo, hi;
        EXECUTE format('ALTER TABLE %s ATTACH PARTITION %s DEFAULT', parent, def);
      END IF;
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END $$;
