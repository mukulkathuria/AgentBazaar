-- Product graph edges for fixed-hop relations. On PostgreSQL 19 a SQL/PGQ property graph is
-- created over this table at startup (see recommendations module); older versions use joins.
CREATE TABLE product_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id uuid NOT NULL,
  b_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('compatible_with', 'bought_together', 'alternative_of')),
  rule text,
  weight real NOT NULL DEFAULT 1,
  UNIQUE (a_id, b_id, kind),
  CHECK (a_id <> b_id)
);
CREATE INDEX product_edges_a_idx ON product_edges (a_id, kind, weight DESC);
