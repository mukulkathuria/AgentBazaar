import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArchive } from './archive.js';

describe('readArchive', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archive-spec-'));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const lines = ['{"id":1,"note":"ā—é"}', '{"id":2,"note":null}'];
  const expectedChecksum = lines
    .map((l) => BigInt(`0x${createHash('sha256').update(l).digest('hex').slice(0, 15)}`))
    .reduce((a, b) => a + b)
    .toString();

  it('counts and checksums every line, multi-byte text included', async () => {
    const file = join(dir, 'ok.jsonl.gz');
    const gz = gzipSync(lines.map((l) => `${l}\n`).join(''));
    await writeFile(file, gz);
    expect(await readArchive(file)).toEqual({
      rows: 2,
      checksum: expectedChecksum,
      sha256: createHash('sha256').update(gz).digest('hex'),
    });
  });

  it('rejects a file cut short, so a damaged archive is never trusted', async () => {
    const file = join(dir, 'cut.jsonl.gz');
    const gz = gzipSync(lines.map((l) => `${l}\n`).join(''));
    await writeFile(file, gz.subarray(0, gz.length - 12));
    await expect(readArchive(file)).rejects.toThrow();
  });

  it('rejects a last line without its newline', async () => {
    const file = join(dir, 'partial.jsonl.gz');
    await writeFile(file, gzipSync(`${lines[0]}\n${lines[1]}`));
    await expect(readArchive(file)).rejects.toThrow(/truncated/);
  });

  it('reads an empty archive as zero rows', async () => {
    const file = join(dir, 'empty.jsonl.gz');
    await writeFile(file, gzipSync(''));
    expect(await readArchive(file)).toMatchObject({ rows: 0, checksum: '0' });
  });
});
