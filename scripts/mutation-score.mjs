#!/usr/bin/env node
// Merges StrykerJS JSON reports (one per nightly shard), prints the score per module and overall, and exits 1
// when the overall score is under the gate, a report is missing, or two reports contain the same file.
// Usage: node scripts/mutation-score.mjs <break %> <expected report count> <report.json>...
import { readFileSync } from 'node:fs';

const [breakAt, expected, ...reports] = process.argv.slice(2);
// Stryker's definition: detected (killed, timed out) over valid (detected, survived, not covered).
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

const byModule = new Map();
const seen = new Set();
const duplicates = [];
for (const report of reports) {
  for (const [file, { mutants }] of Object.entries(JSON.parse(readFileSync(report, 'utf8')).files)) {
    // A file in two reports would count twice; mutation-prune.mjs keeps each shard to its own files.
    if (seen.has(file)) {
      duplicates.push(file);
      continue;
    }
    seen.add(file);
    const name = /modules\/([^/]+)\//.exec(file)?.[1] ?? file;
    const m = byModule.get(name) ?? { detected: 0, undetected: 0 };
    for (const { status } of mutants) {
      if (DETECTED.has(status)) m.detected++;
      else if (UNDETECTED.has(status)) m.undetected++;
    }
    byModule.set(name, m);
  }
}

const score = ({ detected, undetected }) => (detected + undetected ? (100 * detected) / (detected + undetected) : 100);
const total = { detected: 0, undetected: 0 };
for (const [name, m] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`${name.padEnd(16)} ${score(m).toFixed(2).padStart(6)}%  ${m.detected} of ${m.detected + m.undetected}`);
  total.detected += m.detected;
  total.undetected += m.undetected;
}
console.log(`All domain and application code: ${score(total).toFixed(2)}% (${total.detected} of ${total.detected + total.undetected} detected)`);

if (duplicates.length) {
  console.error(`Reported by more than one shard: ${duplicates.join(', ')}`);
  process.exit(1);
}
if (reports.length !== Number(expected)) {
  console.error(`Expected ${expected} shard reports, got ${reports.length}: a shard did not finish.`);
  process.exit(1);
}
if (score(total) < Number(breakAt)) {
  console.error(`Mutation score ${score(total).toFixed(2)}% is under the ${breakAt}% gate.`);
  process.exit(1);
}
