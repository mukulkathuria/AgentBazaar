import { type ComposeRequest, type ComposeResult, type LlmPort, templateResult } from '../domain/ports.js';

/** Default adapter, no keys needed: replies are the policy templates, word for word. */
export class TemplateLlm implements LlmPort {
  async compose(req: ComposeRequest): Promise<ComposeResult> {
    return templateResult(req);
  }
}
