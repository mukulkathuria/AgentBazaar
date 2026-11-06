import { type ComposeRequest, type ComposeResult, type JudgeResult, type LlmPort, templateResult } from '../domain/ports.js';

/** Default adapter, no keys needed: replies are the policy templates, word for word. */
export class TemplateLlm implements LlmPort {
  async compose(req: ComposeRequest): Promise<ComposeResult> {
    return templateResult(req);
  }

  /** Template wording is the policy's own; there is nothing for a judge to check. */
  async judge(): Promise<JudgeResult> {
    return { ok: true, model: 'template', tokensIn: 0, tokensOut: 0 };
  }
}
