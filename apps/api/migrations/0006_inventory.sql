-- Inventory: reservation is a single conditional UPDATE; the CHECK makes overselling impossible.
CREATE TABLE stock_levels (
  variant_id uuid PRIMARY KEY,
  on_hand int NOT NULL CHECK (on_hand >= 0),
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_never_oversold CHECK (reserved <= on_hand)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES stock_levels (variant_id),
  quantity int NOT NULL CHECK (quantity > 0),
  owner_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('held', 'committed', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_held_expiry_idx ON reservations (expires_at) WHERE status = 'held';
CREATE INDEX reservations_owner_idx ON reservations (owner_ref);
