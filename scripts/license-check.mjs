#!/usr/bin/env node
// License gate: every production dependency must use an allow-listed licence.
// AGPL/GPL tools may only run as separate services (never linked); source-available licences are refused.
import { execSync } from 'node:child_process';

const ALLOW = [
  /^MIT/i,
  /^Apache-2\.0/i,
  /^BSD/i,
  /^0BSD$/i,
  /^ISC$/i,
  /^PostgreSQL$/i,
  /^MPL-2\.0$/i,
  /^BlueOak-1\.0\.0$/i,
  /^CC0-1\.0$/i,
  /^Python-2\.0$/i,
  /^Unlicense$/i,
  /^CC-BY-4\.0$/i,
];
const DENY = [/AGPL/i, /^GPL/i, /LGPL/i, /BUSL|BSL-1\.1/i, /SSPL/i, /Elastic/i, /FSL/i, /Commons-Clause/i];

// Packages whose package.json lacks a licence field, reviewed by reading their LICENSE file. Pinned to the
// exact version so an upgrade has to be reviewed again.
const REVIEWED = { 'unionfs@4.6.0': 'Unlicense' };

// -r: every workspace package's production dependencies (the root package itself has none).
const raw = execSync('pnpm licenses list --prod --json -r', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);
const problems = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  // "(MIT OR Apache-2.0)" style expressions pass if any alternative is allowed.
  const options = license
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/i)
    .map((s) => s.trim());
  const ok = options.some((o) => ALLOW.some((re) => re.test(o)) && !DENY.some((re) => re.test(o)));
  for (const p of ok ? [] : pkgs) {
    const ids = (p.versions ?? [p.version]).map((v) => `${p.name}@${v}`);
    if (!ids.every((id) => REVIEWED[id])) problems.push(`${ids.join(', ')}: ${license}`);
  }
}
if (problems.length) {
  console.error(`Disallowed licences in production dependencies:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`License gate passed for ${Object.values(byLicense).flat().length} packages.`);
