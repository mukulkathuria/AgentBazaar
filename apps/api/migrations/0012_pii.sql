-- PII lives in its own schema. Every field is AES-256-GCM encrypted with a per-customer data key;
-- deleting the wrapped key crypto-shreds the customer (DPDP erasure). Lookups use HMAC blind indexes.
CREATE SCHEMA IF NOT EXISTS pii;

CREATE TABLE pii.customers (
  token text PRIMARY KEY,
  wrapped_dek text,
  key_id text NOT NULL,
  email_enc text,
  email_bidx text UNIQUE,
  phone_enc text,
  phone_bidx text,
  name_enc text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz
);
CREATE INDEX pii_customers_phone_bidx ON pii.customers (phone_bidx);

CREATE TABLE pii.addresses (
  token text PRIMARY KEY,
  customer_token text NOT NULL REFERENCES pii.customers (token) ON DELETE CASCADE,
  data_enc text NOT NULL,
  state_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pii_addresses_customer_idx ON pii.addresses (customer_token);

CREATE TABLE pii.consents (
  id bigserial PRIMARY KEY,
  customer_token text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('terms', 'order_fulfilment', 'marketing', 'analytics')),
  granted boolean NOT NULL,
  notice_version text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pii_consents_customer_idx ON pii.consents (customer_token, purpose, id DESC);

CREATE TABLE pii.erasure_requests (
  id bigserial PRIMARY KEY,
  customer_token text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
