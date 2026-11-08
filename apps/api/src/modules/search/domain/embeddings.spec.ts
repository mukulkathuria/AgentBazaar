import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fnv1a32, HASH_DIM, HASH_MODEL, hashEmbed, HashEmbeddings, hashFeatures } from './embeddings.js';
import { byScoreThenId, reciprocalRankFusion } from './ranking.js';

/** Written by services/ai's own tests; absent until that service ships its embedder. */
const PY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../services/ai/tests/fixtures/hash_embeddings.json');

/** Non-zero entries [index, value] from an independent Python implementation of the spec (6 dp). */
const PYTHON_REFERENCE: [string, [number, number][]][] = [
  ['a', [[95, 0.707107], [185, 0.707107]]],
  ['कीबोर्ड और मग', [[5, -0.267261], [6, 0.267261], [24, 0.267261], [87, 0.267261], [99, 0.267261], [121, 0.267261], [133, 0.267261], [141, 0.267261], [180, 0.267261], [188, -0.267261], [219, 0.267261], [232, 0.267261], [248, -0.267261], [252, 0.267261]]],
  ['Café ½ ﬁne Ⅻ ²', [[71, -0.204124], [79, 0.204124], [82, 0.204124], [86, -0.204124], [101, -0.204124], [106, 0.204124], [133, 0.204124], [164, -0.204124], [170, 0.204124], [175, 0.204124], [196, 0.204124], [198, 0.204124], [201, 0.204124], [222, -0.408248], [226, 0.408248], [242, -0.204124], [246, -0.204124], [255, 0.204124]]],
  ['naïve 😀 emoji_snake 𝔘𝔫𝔦𝔠𝔬𝔡𝔢', [[0, -0.182574], [22, -0.182574], [44, 0.182574], [45, 0.182574], [54, -0.182574], [74, -0.182574], [82, 0.182574], [84, -0.182574], [87, -0.182574], [93, -0.182574], [100, -0.182574], [122, -0.182574], [131, -0.365148], [133, 0.182574], [138, -0.182574], [147, -0.182574], [182, 0.182574], [190, 0.182574], [228, 0.182574], [229, -0.182574], [233, 0.182574], [239, 0.182574], [243, 0.182574], [246, -0.365148]]],
];

const expectClose = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(HASH_DIM);
  actual.forEach((x, i) => expect(Math.abs(x - expected[i]!)).toBeLessThanOrEqual(1e-6));
};

describe('@lite hash embeddings (hash-256-v1)', () => {
  it('implements 32-bit FNV-1a over UTF-8 bytes', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    // é hashes as its two UTF-8 bytes (C3 A9), as in Python's s.encode('utf-8').
    expect(fnv1a32('é')).toBe(0x1e9de8c1);
  });

  it('extracts word features and code-point trigrams of "#token#" after NFKC and lowercasing', () => {
    expect(hashFeatures('Hi')).toEqual(['w:hi', 'c:#hi', 'c:hi#']);
    expect(hashFeatures('a')).toEqual(['w:a', 'c:#a#']);
    expect(hashFeatures('ﬁ_1, x!')).toEqual(['w:fi_1', 'c:#fi', 'c:fi_', 'c:i_1', 'c:_1#', 'w:x', 'c:#x#']);
    // Deseret letters are outside the BMP: one code point each, never split into surrogate halves.
    expect(hashFeatures('𐐀𐐁')).toEqual(['w:𐐨𐐩', 'c:#𐐨𐐩', 'c:𐐨𐐩#']);
    expect(hashFeatures('😀 !!')).toEqual([]);
  });

  it('matches an independent Python implementation of the algorithm', () => {
    for (const [text, sparse] of PYTHON_REFERENCE) {
      const expected = new Array<number>(HASH_DIM).fill(0);
      for (const [i, v] of sparse) expected[i] = v;
      expectClose(hashEmbed(text), expected);
    }
  });

  it.skipIf(!existsSync(PY_FIXTURE))('matches services/ai/tests/fixtures/hash_embeddings.json', () => {
    const fixture = JSON.parse(readFileSync(PY_FIXTURE, 'utf8')) as { text: string; vector: number[] }[];
    expect(fixture.length).toBeGreaterThan(0);
    for (const { text, vector } of fixture) expectClose(hashEmbed(text), vector);
  });

  it('is deterministic and L2-normalised, and all zeros without tokens', async () => {
    const e = new HashEmbeddings();
    expect([e.model, e.dim]).toEqual([HASH_MODEL, 256]);
    const [a, b, empty] = await e.embed(['Mechanical keyboard', 'Mechanical keyboard', '?!']);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 12);
    expect(empty!.every((x) => x === 0)).toBe(true);
  });
});

describe('@lite reciprocal rank fusion', () => {
  it('rewards items ranked well by several lists, with k = 60', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'd'],
    ]);
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('orders equal scores by id in code-unit order, whatever order the lists came in', () => {
    // Uppercase sorts before lowercase in code units (as in OpenSearch keyword sorts and Postgres), unlike a locale compare.
    const ids = ['b-2', 'B-2', 'a-10', 'a-9'];
    expect(reciprocalRankFusion([[ids[0]!], [ids[1]!], [ids[2]!], [ids[3]!]]).map((f) => f.id)).toEqual(['B-2', 'a-10', 'a-9', 'b-2']);
    expect(reciprocalRankFusion([[ids[3]!], [ids[2]!], [ids[1]!], [ids[0]!]]).map((f) => f.id)).toEqual(['B-2', 'a-10', 'a-9', 'b-2']);
    expect([{ id: 'x', score: 1 }, { id: 'y', score: 2 }].sort(byScoreThenId).map((f) => f.id)).toEqual(['y', 'x']);
  });
});
