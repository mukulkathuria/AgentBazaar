-- Recommendations read edges in both directions (compatibility and co-purchase are symmetric);
-- 0010 only indexes the a_id side.
CREATE INDEX product_edges_b_idx ON product_edges (b_id, kind, weight DESC);
