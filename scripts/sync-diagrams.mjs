#!/usr/bin/env node
// Rewrites Mermaid blocks in README.md and docs/**/*.md from their sources in docs/diagrams/<name>.mmd.
// A block is everything between `<!-- diagram:<name> -->` and `<!-- /diagram:<name> -->`.
//   node scripts/sync-diagrams.mjs           update the Markdown files   (pnpm docs:sync)
//   node scripts/sync-diagrams.mjs --check   exit 1 if any block is stale (pnpm docs:check, CI)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const sources = join(docs, 'diagrams');
const check = process.argv.includes('--check');
const BLOCK = /<!-- diagram:([a-z0-9-]+) -->[\s\S]*?<!-- \/diagram:\1 -->/g;
// Compare with LF everywhere, so a CRLF checkout on Windows is not reported as stale.
const lf = (s) => s.replace(/\r\n/g, '\n');
const rel = (p) => relative(root, p).replace(/\\/g, '/');

const files = [join(root, 'README.md')];
if (existsSync(docs)) {
  for (const f of readdirSync(docs, { recursive: true })) if (String(f).endsWith('.md')) files.push(join(docs, String(f)));
}

const missing = [];
const stale = [];
let blocks = 0;
for (const file of files) {
  const before = lf(readFileSync(file, 'utf8'));
  const after = before.replace(BLOCK, (block, name) => {
    blocks++;
    const src = join(sources, `${name}.mmd`);
    if (!existsSync(src)) {
      missing.push(`${rel(file)}: no source docs/diagrams/${name}.mmd`);
      return block;
    }
    const mermaid = lf(readFileSync(src, 'utf8')).trim();
    return `<!-- diagram:${name} -->\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n<!-- /diagram:${name} -->`;
  });
  if (after === before) continue;
  stale.push(rel(file));
  if (!check) writeFileSync(file, after);
}

if (missing.length) {
  console.error(`Diagram markers without a source file:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
if (check && stale.length) {
  console.error(`Stale diagrams in: ${stale.join(', ')}\nRun \`pnpm docs:sync\` and commit the result.`);
  process.exit(1);
}
console.log(
  check
    ? `Diagrams up to date (${blocks} blocks in ${files.length} files).`
    : `Synced ${blocks} diagram blocks${stale.length ? `; updated ${stale.join(', ')}` : '; nothing changed'}.`,
);
