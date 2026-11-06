import { ClassifyResponse, type Language } from '@agentbazaar/contracts';
import { classifyRules } from '../domain/classifier.js';
import type { ClassifierPort } from '../domain/ports.js';
import type { RemoteGuard } from './resilient.js';

/** Default: the deterministic English/Hindi/Hinglish rules, in process. */
export class RulesClassifier implements ClassifierPort {
  async classify(text: string, languageHint?: Language): Promise<ClassifyResponse> {
    return classifyRules(text, languageHint);
  }
}

/** The Python AI service (rules or a fine-tuned model). Any failure falls back to the in-process rules. */
export class AiServiceClassifier implements ClassifierPort {
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly guard: RemoteGuard,
    private readonly fallback: ClassifierPort = new RulesClassifier(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly headers: Record<string, string> = {},
  ) {
    this.url = `${baseUrl.replace(/\/+$/, '')}/v1/classify`;
  }

  async classify(text: string, languageHint?: Language): Promise<ClassifyResponse> {
    try {
      return await this.guard.run(async (signal) => {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', ...this.headers },
          body: JSON.stringify({ text: text.slice(0, 4000), ...(languageHint ? { language_hint: languageHint } : {}) }),
        });
        if (!res.ok) throw new Error(`AI service answered HTTP ${res.status}`);
        return ClassifyResponse.parse(await res.json());
      });
    } catch (err) {
      this.onError(err);
      return this.fallback.classify(text, languageHint);
    }
  }
}
