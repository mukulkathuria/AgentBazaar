import {
  type ComposeRequest,
  type ComposeResult,
  FALLBACK_MODEL,
  judgeFailed,
  type JudgeRequest,
  type JudgeResult,
  type LlmPort,
  templateResult,
} from '../domain/ports.js';

/**
 * Provider fallback (LLM_FALLBACK_ADAPTER). Each adapter guards its provider with its own circuit
 * breaker, so while the first provider is failing or its breaker is open, its calls fail fast and the
 * next provider answers. If every provider fails, the template is sent, as with a single adapter.
 */
export class FallbackLlm implements LlmPort {
  constructor(private readonly chain: readonly LlmPort[]) {}

  async compose(req: ComposeRequest): Promise<ComposeResult> {
    for (const llm of this.chain) {
      const r = await llm.compose(req);
      if (r.model !== FALLBACK_MODEL) return r;
    }
    return templateResult(req, FALLBACK_MODEL);
  }

  async judge(req: JudgeRequest): Promise<JudgeResult> {
    for (const llm of this.chain) {
      const r = await llm.judge(req);
      if (r.model !== FALLBACK_MODEL) return r;
    }
    return judgeFailed();
  }
}
