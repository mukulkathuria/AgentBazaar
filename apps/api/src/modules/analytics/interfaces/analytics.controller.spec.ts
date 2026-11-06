import { describe, expect, it } from 'vitest';
import { ingestKeyMatches } from './analytics.controller.js';

describe('@lite analytics ingest key', () => {
  it('compares ingest keys exactly, whatever their length', () => {
    expect(ingestKeyMatches('s3cret-key', 's3cret-key')).toBe(true);
    expect(ingestKeyMatches('s3cret-kez', 's3cret-key')).toBe(false);
    expect(ingestKeyMatches('s3cret', 's3cret-key')).toBe(false);
    expect(ingestKeyMatches(undefined, 's3cret-key')).toBe(false);
  });
});
