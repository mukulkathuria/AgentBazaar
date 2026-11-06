import { type SQL, sql } from 'drizzle-orm';
import type { KeyWrapper } from '../../../shared/crypto/keyring.js';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';

/** OpenBao Transit as the re-wrap target: a KeyWrapper that can also rotate ciphertext in place. */
export interface TransitKeyWrapper extends KeyWrapper {
  rewrap(wrapped: string, context: string): Promise<string>;
  latestVersion(): Promise<number>;
}

export interface RewrapReport {
  /** Data keys moved from the env master key to OpenBao Transit. */
  moved: number;
  /** Transit-wrapped data keys brought up to the latest key version. */
  rotated: number;
  /** Data keys still wrapped by the env master key (written while this ran): run the command again. */
  remaining: number;
  /** Data keys wrapped by a key that is neither the env master key nor the Transit key. */
  unknownKey: number;
}

type Convert = (wrapped: string, token: string) => Promise<string>;

/**
 * Converts matching rows batch by batch, each batch in one transaction, so a crash loses nothing.
 * The token cursor visits each row at most once per run, even if the key is rotated meanwhile.
 */
async function inBatches(
  db: Executor,
  where: SQL,
  convert: Convert,
  keyId: string,
  batchSize: number,
): Promise<number> {
  let done = 0;
  let cursor = '';
  for (;;) {
    const batch = await inTransaction(db, async (tx) => {
      const picked = await rows<{ token: string; wrapped_dek: string }>(
        tx,
        sql`SELECT token, wrapped_dek FROM pii.customers WHERE wrapped_dek IS NOT NULL AND token > ${cursor} AND ${where}
            ORDER BY token LIMIT ${batchSize} FOR UPDATE`,
      );
      for (const r of picked) {
        const wrapped = await convert(r.wrapped_dek, r.token);
        await tx.execute(
          sql`UPDATE pii.customers SET wrapped_dek = ${wrapped}, key_id = ${keyId} WHERE token = ${r.token}`,
        );
      }
      return picked;
    });
    done += batch.length;
    if (batch.length < batchSize) return done;
    cursor = batch[batch.length - 1]!.token;
  }
}

/**
 * Lite to growth: re-wraps every customer's data key from the env master key (PII_MASTER_KEY) to
 * OpenBao Transit, then brings Transit ciphertext from older key versions up to the latest. Only the
 * 32-byte data keys pass through memory; the encrypted PII fields are never read or decrypted.
 * Rows already wrapped by the latest Transit version are skipped, so it is idempotent, and every
 * batch commits on its own, so an interrupted run resumes where it stopped.
 */
export async function rewrapDataKeys(
  db: Executor,
  local: KeyWrapper,
  transit: TransitKeyWrapper,
  batchSize = 100,
): Promise<RewrapReport> {
  const moved = await inBatches(
    db,
    sql`key_id = ${local.keyId}`,
    async (wrapped, token) => {
      const dek = await local.unwrap(wrapped, token);
      const next = await transit.wrap(dek, token);
      // Read it back before the env-wrapped copy is replaced: a bad Transit setup must not shred anyone.
      if (!(await transit.unwrap(next, token)).equals(dek))
        throw new Error(`OpenBao round trip changed the data key of ${token}`);
      return next;
    },
    transit.keyId,
    batchSize,
  );
  const latest = `vault:v${await transit.latestVersion()}:%`;
  const rotated = await inBatches(
    db,
    sql`key_id = ${transit.keyId} AND wrapped_dek NOT LIKE ${latest}`,
    (wrapped, token) => transit.rewrap(wrapped, token),
    transit.keyId,
    batchSize,
  );
  const count = async (where: SQL) =>
    (
      await one<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM pii.customers WHERE wrapped_dek IS NOT NULL AND ${where}`,
      )
    )?.n ?? 0;
  return {
    moved,
    rotated,
    remaining: await count(sql`key_id = ${local.keyId}`),
    unknownKey: await count(sql`key_id NOT IN (${local.keyId}, ${transit.keyId})`),
  };
}
