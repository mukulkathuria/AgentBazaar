import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/shared/crypto/primitives.js';
import { withIdempotencyKey } from '../../src/shared/http/idempotency.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

// Regression (found by test/services/resilience.spec.ts): when the database failed mid-request, the key
// could not be released, so every retry with the same Idempotency-Key got 409 "in progress" forever.
describe('@lite regression: an abandoned idempotency claim is released after its lease', () => {
  let t: TestDb;
  const request = { cartId: 'c-1' };
  const created = async () => ({ status: 201, body: { orderId: 'o-1' } });
  const claim = (key: string, age: string, hash = sha256Hex(JSON.stringify(request))) =>
    t.database.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at) VALUES ('checkout', $1, $2, 'in_progress', now() - $3::interval)`,
      [key, hash, age],
    );

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.cleanup());

  it('lets the same request take over a claim abandoned over a minute ago', async () => {
    await claim('key-abandoned', '61 seconds');
    const r = await withIdempotencyKey(t.database.db, 'checkout', 'key-abandoned', request, created);
    expect(r).toEqual({ status: 201, body: { orderId: 'o-1' }, replayed: false });
    // ...and a retry after that replays the stored answer.
    const again = await withIdempotencyKey(t.database.db, 'checkout', 'key-abandoned', request, created);
    expect(again).toMatchObject({ status: 201, replayed: true });
  });

  it('keeps a recent claim locked', async () => {
    await claim('key-recent', '5 seconds');
    await expect(
      withIdempotencyKey(t.database.db, 'checkout', 'key-recent', request, created),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('never hands an abandoned claim to a different request', async () => {
    await claim('key-other', '10 minutes', sha256Hex(JSON.stringify({ cartId: 'c-2' })));
    await expect(
      withIdempotencyKey(t.database.db, 'checkout', 'key-other', request, created),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
});
