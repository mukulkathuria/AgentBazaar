-- Payments: the gateway holds card data. Webhooks are idempotent by (provider, event_id).
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('mock', 'razorpay', 'youpi-pg', 'cod')),
  status text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  currency text NOT NULL DEFAULT 'INR',
  provider_order_id text,
  provider_payment_id text,
  utr text,
  payment_url text,
  client_params jsonb NOT NULL DEFAULT '{}',
  access_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  provider_refund_id text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_one_per_payment ON refunds (payment_id) WHERE status <> 'failed';

CREATE TABLE webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  outcome text,
  PRIMARY KEY (provider, event_id)
);
