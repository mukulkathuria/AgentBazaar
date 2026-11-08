#!/usr/bin/env node
// Keeps only this shard's source files in a StrykerJS incremental file. Stryker carries forward the results
// of files outside `mutate`, so after the shard layout changes a cache would otherwise report another
// shard's files (stale, and counted twice by mutation-score.mjs).
// Usage: node scripts/mutation-prune.mjs <incremental.json> "<STRYKER_SHARD>"
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file, shard = ''] = process.argv.slice(2);
const prefixes = shard.split(/\s+/).filter(Boolean).map((s) => `src/modules/${s}/`);
if (!file || !existsSync(file) || !prefixes.length) process.exit(0);

const report = JSON.parse(readFileSync(file, 'utf8'));
const files = Object.entries(report.files);
report.files = Object.fromEntries(files.filter(([name]) => prefixes.some((p) => name.replaceAll('\\', '/').includes(p))));
writeFileSync(file, JSON.stringify(report));
console.log(`Kept ${Object.keys(report.files).length} of ${files.length} files for shard "${shard}"`);
