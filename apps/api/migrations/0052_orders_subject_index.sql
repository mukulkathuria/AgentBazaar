-- A customer's order history matches `customer_token = $1 OR subject = $2` (orders.service.ts listForCustomer).
-- With only customer_token indexed, the OR made Postgres scan every order; indexing subject lets it combine both
-- indexes (BitmapOr). Found by the data-scale suite (docs/benchmarks/data-scale.md).
CREATE INDEX orders_subject_idx ON orders (subject, created_at DESC);
