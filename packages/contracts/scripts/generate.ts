/**
 * Generates OpenAPI and AI-service JSON Schemas from the Zod contracts.
 * `--check` fails when committed files are stale, so CI catches hand edits and drift.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildOpenApi } from '../src/openapi.js';
import { AI_CONTRACTS } from '../src/ai.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'generated');
const check = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const files = new Map<string, unknown>([['openapi.json', buildOpenApi(version)]]);
for (const [name, schema] of Object.entries(AI_CONTRACTS)) {
  files.set(`ai/${name}.json`, z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }));
}

let stale = 0;
for (const [rel, content] of files) {
  const path = join(out, rel);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`stale: ${rel}`);
      stale++;
    }
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
if (stale) {
  console.error('Run `pnpm contracts:generate` and commit the result.');
  process.exit(1);
}
console.log(check ? 'contracts up to date' : `wrote ${files.size} files to ${out}`);
