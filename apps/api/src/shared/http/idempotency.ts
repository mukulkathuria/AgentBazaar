import { sql } from 'drizzle-orm';
import { one, type Executor } from '../db/database.js';
import { safeEqual, sha256Hex } from '../crypto/primitives.js';
import { AppError } from '../kernel/errors.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

interface Stored {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Executes `fn` once per (scope, key). A retry with the same key and body returns the stored
 * response; the same key with a different body is rejected. Failed attempts release the key, and an
 * attempt that could not (crash, database outage) loses it after a minute.
 */
export async function withIdempotencyKey<T>(
  db: Executor,
  scope: string,
  key: string | undefined,
  request: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key || !KEY_FORMAT.test(key)) {
    throw new AppError('validation_failed', 'An Idempotency-Key header (8-128 chars of A-Z, a-z, 0-9, _ or -) is required');
  }
  const hash = sha256Hex(JSON.stringify(request ?? null));
  // A claim left in progress for over a minute was abandoned (the process died, or the database failed
  // before the key could be released), so the same request may take it over; otherwise it stays locked.
  const claimed = await one<{ key: string }>(
    db,
    sql`INSERT INTO idempotency_keys (scope, key, request_hash, status) VALUES (${scope}, ${key}, ${hash}, 'in_progress')
        ON CONFLICT (scope, key) DO UPDATE SET created_at = now()
          WHERE idempotency_keys.status = 'in_progress' AND idempotency_keys.request_hash = excluded.request_hash
            AND idempotency_keys.created_at < now() - interval '60 seconds'
        RETURNING key`,
  );
  if (!claimed) {
    const existing = await one<Stored>(
      db,
      sql`SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE scope = ${scope} AND key = ${key}`,
    );
    if (!existing) return withIdempotencyKey(db, scope, key, request, fn);
    if (!safeEqual(existing.request_hash, hash)) {
      throw new AppError('idempotency_conflict', 'This Idempotency-Key was already used with a different request');
    }
    if (existing.status === 'in_progress') throw new AppError('conflict', 'A request with this Idempotency-Key is in progress');
    return { status: existing.response_status ?? 200, body: existing.response_body as T, replayed: true };
  }
  try {
    const result = await fn();
    await db.execute(
      sql`UPDATE idempotency_keys SET status = 'completed', response_status = ${result.status},
          response_body = ${JSON.stringify(result.body)}::jsonb WHERE scope = ${scope} AND key = ${key}`,
    );
    return { ...result, replayed: false };
  } catch (err) {
    await db.execute(sql`DELETE FROM idempotency_keys WHERE scope = ${scope} AND key = ${key}`);
    throw err;
  }
}
