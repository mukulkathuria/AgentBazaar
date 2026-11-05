-- Carts, checkout sessions, orders with an append-only event log, and returns.
CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  customization jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cart_lines_cart_idx ON cart_lines (cart_id);

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('cart', 'quote')),
  source_ref text NOT NULL,
  subject text NOT NULL,
  lines jsonb NOT NULL,
  subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0),
  status text NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_open_expiry_idx ON checkout_sessions (expires_at) WHERE status = 'open';

CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  status text NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('online', 'cod')),
  subject text NOT NULL,
  customer_token text NOT NULL,
  address_token text NOT NULL,
  place_of_supply text NOT NULL,
  subtotal_paise bigint NOT NULL,
  tax_paise bigint NOT NULL,
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  currency text NOT NULL DEFAULT 'INR',
  checkout_session_id uuid UNIQUE,
  access_token_hash text NOT NULL,
  invoice_number text,
  tracking_number text,
  payment_expires_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0
);
CREATE INDEX orders_customer_idx ON orders (customer_token, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, payment_expires_at);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  product_name text NOT NULL,
  hsn_code text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price_paise bigint NOT NULL,
  total_paise bigint NOT NULL,
  taxable_paise bigint NOT NULL,
  taxes jsonb NOT NULL DEFAULT '[]',
  non_returnable boolean NOT NULL DEFAULT false,
  reservation_id uuid
);
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

-- Snapshot of validated customization values at the time of the order.
CREATE TABLE order_line_customizations (
  order_line_id uuid PRIMARY KEY REFERENCES order_lines (id) ON DELETE CASCADE,
  values jsonb NOT NULL
);

CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id),
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  reason text NOT NULL,
  note text,
  status text NOT NULL CHECK (status IN ('requested', 'received', 'refunded', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX return_requests_one_open ON return_requests (order_id) WHERE status IN ('requested', 'received');
