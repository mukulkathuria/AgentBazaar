-- Append-only audit trail and redacted LLM traces.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE llm_traces (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  session_id uuid,
  channel text NOT NULL,
  tier int NOT NULL,
  shadow_tier int,
  model text NOT NULL,
  intent text NOT NULL,
  input_redacted text NOT NULL,
  output_redacted text NOT NULL,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  cost_micro_inr bigint NOT NULL DEFAULT 0,
  latency_ms int NOT NULL DEFAULT 0,
  guard_fallback boolean NOT NULL DEFAULT false,
  sampled_for_audit boolean NOT NULL DEFAULT false
);
CREATE INDEX llm_traces_session_idx ON llm_traces (session_id, id);
CREATE TRIGGER llm_traces_append_only BEFORE UPDATE OR DELETE ON llm_traces FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
