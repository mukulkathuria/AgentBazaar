-- What an LLM trace records: a phrasing call, the observer's judge call, or a reply reused from the semantic cache.
ALTER TABLE llm_traces ADD COLUMN kind text NOT NULL DEFAULT 'compose' CHECK (kind IN ('compose', 'judge', 'cache'));
