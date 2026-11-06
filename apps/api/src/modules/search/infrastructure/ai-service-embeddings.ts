import { EmbedResponse } from '@agentbazaar/contracts';
import { HASH_DIM, HashEmbeddings, type EmbeddingsPort } from '../domain/embeddings.js';
import { JsonHttp, type JsonHttpOptions } from './json-http.js';

/** EmbedRequest limits from the contract. */
const BATCH = 64;
const MAX_CHARS = 2000;

export interface AiServiceEmbeddingsOptions extends JsonHttpOptions {
  /** Called when the service fails and hash vectors are used instead. */
  onFallback?: (err: unknown) => void;
}

/**
 * Embeddings from services/ai (`POST /v1/embed`). Falls back to hash vectors when the service is
 * down, slow or returns the wrong shape, so search keeps working. If the service runs a model other
 * than hash-256-v1, fallback vectors live in a different space: the vector leg is weak for those
 * calls while the keyword legs are unaffected.
 */
export class AiServiceEmbeddings implements EmbeddingsPort {
  readonly model = 'ai-service';
  readonly dim = HASH_DIM;
  private readonly http: JsonHttp;
  private readonly fallback = new HashEmbeddings();

  constructor(
    baseUrl: string,
    private readonly opts: AiServiceEmbeddingsOptions = {},
  ) {
    this.http = new JsonHttp('ai-service', baseUrl, { timeoutMs: 1500, ...opts });
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) out.push(...(await this.batch(texts.slice(i, i + BATCH))));
      return out;
    } catch (err) {
      this.opts.onFallback?.(err);
      return this.fallback.embed(texts);
    }
  }

  private async batch(texts: readonly string[]): Promise<number[][]> {
    const res = EmbedResponse.parse(await this.http.request('POST', '/v1/embed', { texts: texts.map((t) => t.slice(0, MAX_CHARS)) }));
    if (res.vectors.length !== texts.length || res.vectors.some((v) => v.length !== this.dim)) {
      throw new Error(`ai-service returned ${res.vectors.length} vectors of ${res.dim} dims; expected ${texts.length} of ${this.dim}`);
    }
    return res.vectors;
  }
}
