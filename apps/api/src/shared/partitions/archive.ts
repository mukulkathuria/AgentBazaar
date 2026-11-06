import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip } from 'node:zlib';
import type { Database } from '../db/database.js';
import { PARTITIONED_TABLES } from './partitions.js';

export interface ArchiveOptions {
  /** First month to keep (UTC, YYYY-MM). Partitions of earlier months are archived. */
  before?: string;
  /** Instead of `before`: keep this many whole months before the current one (for schedules). */
  olderThanMonths?: number;
  /** Directory that receives one folder per table (ARCHIVE_DIR). */
  dir: string;
  /** Defaults to every partitioned table. */
  tables?: readonly string[];
  now?: Date;
  log?: (line: string) => void;
}

export interface ArchivedPartition {
  table: string;
  partition: string;
  rows: number;
  /** Sum of the first 60 bits of each JSON line's SHA-256: order-independent, computed by the database and the file. */
  rowsChecksum: string;
  file: string;
  /** SHA-256 of the gzip file, for checking the archive later. */
  sha256: string;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
// Only names of this shape are ever put into SQL text below, so quoting them is enough.
const PARTITION = /^([a-z_]+)_p(\d{6})$/;
const BLOCKS_PER_QUERY = 1024; // 8 MB of heap

const lineChecksum = (line: string): bigint => BigInt(`0x${createHash('sha256').update(line).digest('hex').slice(0, 15)}`);

/**
 * Archives every partition of a month before `before`: detach it, write its rows as gzip JSON lines, check the
 * file's row count and checksum against the table, then drop the table. Rows are copied as stored; personal data
 * lives only in the pii schema, so event rows carry tokens, never names or contact details. Re-running is safe:
 * finished partitions are gone, and a partition left detached by an interrupted run is picked up again.
 */
export async function archivePartitions(db: Database, opts: ArchiveOptions): Promise<ArchivedPartition[]> {
  const now = opts.now ?? new Date();
  if ((opts.before === undefined) === (opts.olderThanMonths === undefined)) {
    throw new Error('Give either --before YYYY-MM or --older-than MONTHS');
  }
  const before =
    opts.before ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - opts.olderThanMonths!, 1)).toISOString().slice(0, 7);
  const m = MONTH.exec(before);
  if (!m) throw new Error(`--before must be a month as YYYY-MM, got "${before}"`);
  const cutoff = `${m[1]}${m[2]}`;
  const thisMonth = now.toISOString().slice(0, 7);
  if (cutoff > thisMonth.replace('-', '')) throw new Error(`--before ${before} would archive the current month; use ${thisMonth} or earlier`);
  const tables = opts.tables ?? PARTITIONED_TABLES;
  const unknown = tables.filter((t) => !(PARTITIONED_TABLES as readonly string[]).includes(t));
  if (unknown.length) throw new Error(`Not a partitioned table: ${unknown.join(', ')}`);

  const parts = await db.query<{ name: string; parent: string | null }>(
    `SELECT c.relname AS name, p.relname AS parent FROM pg_class c
       LEFT JOIN pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_class p ON p.oid = i.inhparent
     WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname ~ '_p[0-9]{6}$'
     ORDER BY c.relname`,
  );
  const archived: ArchivedPartition[] = [];
  for (const { name, parent } of parts) {
    const [, table = '', month = ''] = PARTITION.exec(name) ?? [];
    if (!tables.includes(table) || month >= cutoff || (parent !== null && parent !== table)) continue;
    const done = await archiveOne(db, table, name, parent !== null, opts);
    if (done) archived.push(done);
  }
  return archived;
}

async function archiveOne(db: Database, table: string, name: string, attached: boolean, opts: ArchiveOptions) {
  const log = opts.log ?? (() => undefined);
  if (table === 'outbox_events') {
    const [p] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}" WHERE published_at IS NULL`);
    if (p!.n > 0) {
      log(`${name}: skipped, ${p!.n} events are not published yet`);
      return null;
    }
  }
  if (attached) {
    await db.scriptTransaction(async (s) => {
      await s.query(`SET LOCAL lock_timeout = '5s'`);
      await s.query(`ALTER TABLE "${table}" DETACH PARTITION "${name}"`);
    });
  }
  await mkdir(join(opts.dir, table), { recursive: true });
  const file = join(opts.dir, table, `${name}.jsonl.gz`);
  await exportRows(db, name, file);
  const [expected] = await db.query<{ rows: number; checksum: string }>(
    `SELECT count(*)::int AS rows,
            coalesce(sum(('x' || left(encode(sha256(convert_to(row_to_json(t)::text, 'UTF8')), 'hex'), 15))::bit(60)::bigint), 0)::text AS checksum
     FROM "${name}" t`,
  );
  const found = await readArchive(file);
  if (found.rows !== expected!.rows || found.checksum !== expected!.checksum) {
    throw new Error(`${name}: ${file} does not match the table (${found.rows} rows vs ${expected!.rows}); the table is kept, detached`);
  }
  const result: ArchivedPartition = { table, partition: name, rows: found.rows, rowsChecksum: found.checksum, file, sha256: found.sha256 };
  const month = `${name.slice(-6, -2)}-${name.slice(-2)}`;
  await writeFile(file.replace(/\.jsonl\.gz$/, '.manifest.json'), `${JSON.stringify({ ...result, month, archivedAt: new Date() }, null, 2)}\n`);
  await db.query(`DROP TABLE "${name}"`);
  log(`${name}: ${found.rows} rows -> ${file}`);
  return result;
}

/** Writes the table's rows as JSON lines, a block range per query, to `file` (via a temporary name). */
async function exportRows(db: Database, name: string, file: string): Promise<void> {
  const [size] = await db.query<{ blocks: number }>(
    `SELECT (pg_relation_size($1::regclass) / current_setting('block_size')::int)::int AS blocks`,
    [name],
  );
  async function* lines() {
    for (let b = 0; b < size!.blocks; b += BLOCKS_PER_QUERY) {
      const batch = await db.query<{ line: string }>(
        `SELECT row_to_json(t)::text AS line FROM "${name}" t WHERE ctid >= $1::tid AND ctid < $2::tid`,
        [`(${b},0)`, `(${b + BLOCKS_PER_QUERY},0)`],
      );
      if (batch.length) yield batch.map((r) => `${r.line}\n`).join('');
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(`${file}.partial`, { mode: 0o600 }));
  await rename(`${file}.partial`, file);
}

/** Counts and checksums the lines of an archive exactly as written, and hashes the file itself. */
export async function readArchive(file: string): Promise<{ rows: number; checksum: string; sha256: string }> {
  const sha = createHash('sha256');
  let rows = 0;
  let sum = 0n;
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        sha.update(chunk);
        done(null, chunk);
      },
    }),
    createGunzip(),
    async (source: AsyncIterable<Buffer>) => {
      const text = new StringDecoder('utf8');
      let rest = '';
      for await (const chunk of source) {
        const lines = (rest + text.write(chunk)).split('\n');
        rest = lines.pop()!;
        for (const line of lines) {
          rows += 1;
          sum += lineChecksum(line);
        }
      }
      if (rest + text.end()) throw new Error(`${file} is truncated`);
    },
  );
  return { rows, checksum: sum.toString(), sha256: sha.digest('hex') };
}
