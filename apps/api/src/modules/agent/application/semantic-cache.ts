import type { Cache } from '../../../shared/cache/cache.js';
import { sha256Hex } from '../../../shared/crypto/primitives.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import type { EmbeddingsPort } from '../../search/index.js';
import { checkReply } from '../domain/guard.js';
import type { ComposeRequest } from '../domain/ports.js';
import { cacheContext, cosine, echoesBuyer, fillSlots, type Slotted, templateShape, toSlots } from '../domain/semantic-cache.js';

interface Entry {
  /** Embedding of the buyer's redacted, number-masked message. */
  v: number[];
  /** Model wording with every number replaced by a slot of its template. */
  reply: Slotted;
}

export interface CacheLookup {
  /** A cached reply, re-filled with this request's numbers and passed by the guard; null on a miss. */
  text: string | null;
  /** Offers a guard-approved model reply for reuse. It is stored only if it is safe to share. */
  remember(reply: string): Promise<void>;
}

type Outcome = 'hit' | 'miss' | 'rejected' | 'stored' | 'skipped' | 'error';

const ENTRIES_PER_TEMPLATE = 8;
// Numbers are re-filled from policy on every hit, so the TTL only bounds how long wording and the
// message vectors behind it are kept (and so how long an erased buyer's redacted text lingers).
const TTL_S = 3600;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const nothing: CacheLookup = { text: null, remember: async () => undefined };

/**
 * Semantic cache for model phrasing (SEMANTIC_CACHE, ADR 0012). The key is exact on the route tier,
 * intent, language and the template's wording around its numbers; the buyer's message only has to be
 * similar. Safety never rests on the similarity: every hit is re-filled from the current template and
 * re-checked by the guard. Constructed without a store, it is off.
 */
export class SemanticCache {
  constructor(
    private readonly store: Cache | null,
    private readonly embeddings: EmbeddingsPort,
    private readonly threshold: number,
    private readonly metrics: Metrics,
    private readonly prefix = 'semcache:',
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async lookup(req: ComposeRequest, allowed: readonly number[]): Promise<CacheLookup> {
    if (!this.store) return nothing;
    try {
      return await this.find(this.store, req, allowed);
    } catch (err) {
      this.failed(err);
      return nothing;
    }
  }

  private async find(store: Cache, req: ComposeRequest, allowed: readonly number[]): Promise<CacheLookup> {
    const shape = templateShape(req.fallback);
    const route = `${req.tier}:${req.intent}:${req.language}:${this.embeddings.model}`;
    const key = `${this.prefix}${route}:${sha256Hex(shape.skeleton).slice(0, 32)}`;
    const context = cacheContext(req.userText ?? '');
    let vector: number[] | undefined;
    const embed = async () => (vector ??= (await this.embeddings.embed([context]))[0]!.map(round4));

    const entries = (await store.get<Entry[]>(key)) ?? [];
    const best = entries.length ? this.closest(entries, await embed()) : undefined;
    const text = best ? fillSlots(best.reply, shape.numbers) : null;
    const safe = text !== null && checkReply(text, allowed).ok;
    this.count(safe ? 'hit' : best ? 'rejected' : 'miss');

    const remember = async (reply: string): Promise<void> => {
      const slotted = toSlots(reply, shape.numbers);
      if (slotted === null || echoesBuyer(reply, req.userText ?? '', `${req.fallback} ${JSON.stringify(req.facts)}`)) return this.count('skipped');
      try {
        // shortcut: concurrent writes to one key can drop an entry (last write wins); harmless for a cache.
        const latest = (await store.get<Entry[]>(key)) ?? [];
        await store.set(key, [{ v: await embed(), reply: slotted }, ...latest].slice(0, ENTRIES_PER_TEMPLATE), TTL_S);
        this.count('stored');
      } catch (err) {
        this.failed(err);
      }
    };
    return { text: safe ? text : null, remember };
  }

  private closest(entries: readonly Entry[], v: readonly number[]): Entry | undefined {
    let best: Entry | undefined;
    let score = this.threshold;
    for (const e of entries) {
      const s = cosine(e.v, v);
      if (s >= score) [best, score] = [e, s];
    }
    return best;
  }

  private count(outcome: Outcome): void {
    this.metrics.semanticCache.inc({ outcome });
  }

  private failed(err: unknown): void {
    this.count('error');
    this.onError(err);
  }
}
