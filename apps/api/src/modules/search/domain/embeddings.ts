/** Turns texts into fixed-size vectors for the vector leg of hybrid search. */
export interface EmbeddingsPort {
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const HASH_DIM = 256;
export const HASH_MODEL = 'hash-256-v1';

// Same character class as Python's Unicode `\w`, so services/ai produces identical features.
const TOKEN = /[\p{L}\p{N}_]+/gu;
const utf8 = new TextEncoder();

/** FNV-1a, 32-bit, over the UTF-8 bytes of `s`. */
export function fnv1a32(s: string): number {
  let h = 2166136261;
  for (const byte of utf8.encode(s)) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return h;
}

/** Word features plus character trigrams of "#token#", counted by code point. */
export function hashFeatures(text: string): string[] {
  const features: string[] = [];
  for (const [token] of text.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    features.push(`w:${token}`);
    const cps = [...`#${token}#`];
    for (let i = 0; i + 3 <= cps.length; i++) features.push(`c:${cps[i]}${cps[i + 1]}${cps[i + 2]}`);
  }
  return features;
}

/** Signed feature hashing into HASH_DIM buckets, L2-normalised (all zeros when there are no tokens). */
export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_DIM).fill(0);
  for (const f of hashFeatures(text)) {
    const h = fnv1a32(f);
    vec[h % HASH_DIM]! += (h >>> 31) & 1 ? -1 : 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/** Deterministic, dependency-free default. Lexical rather than semantic, but needs no model. */
export class HashEmbeddings implements EmbeddingsPort {
  readonly model = HASH_MODEL;
  readonly dim = HASH_DIM;

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(hashEmbed);
  }
}
