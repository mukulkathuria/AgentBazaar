-- Agent layer: chat sessions keep a compact structured state instead of the full transcript.
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  channel text NOT NULL DEFAULT 'chat',
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  state jsonb NOT NULL DEFAULT '{}',
  tokens_used int NOT NULL DEFAULT 0,
  cost_micro_inr bigint NOT NULL DEFAULT 0,
  turns int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('buyer', 'seller')),
  text_redacted text NOT NULL,
  tier int,
  intent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_session_idx ON chat_messages (session_id, id);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX handoffs_one_open ON handoffs (session_id) WHERE status = 'open';
