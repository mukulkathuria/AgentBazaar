// Soak monitor for tests/load/lite.js (docs/benchmarks/soak-lite.md).
// Sample: writes one CSV row a minute with API memory, event-loop lag, Postgres connections, outbox
// backlog, processed_events growth and per-minute server-side latency and errors.
//   BASE_URL=http://localhost:4000 DATABASE_URL=postgres://... [MINUTES=480] \
//     node tests/load/soak-monitor.mjs tests/load/results/soak.csv
// Check: fails (exit 1) when memory, handles, connections or the outbox backlog grow after warm-up.
//   node tests/load/soak-monitor.mjs --check tests/load/results/soak.csv [--warmup-min 30]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const COLUMNS = [
  'ts',
  'elapsed_min',
  'ready',
  'rss_mb',
  'heap_used_mb',
  'heap_total_mb',
  'external_mb',
  'el_lag_p99_ms',
  'handles',
  'pg_conns',
  'outbox_pending',
  'outbox_oldest_s',
  'processed_events',
  'orders',
  'reqs',
  'err_4xx',
  'err_5xx',
  'read_p95_ms',
  'checkout_p95_ms',
];
const P = 'agentbazaar_';
const MB = 1024 * 1024;

export function parseMetrics(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = {};
    for (const [, k, v] of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v;
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

const groupOf = ({ method, route = '' }) =>
  method === 'GET' && /^\/api\/v1\/(products|availability|categories)/.test(route)
    ? 'read'
    : method === 'POST' && route.startsWith('/api/v1/checkout/sessions')
      ? 'checkout'
      : null;

/** Cumulative counters from one scrape: request and error totals plus latency buckets per group. */
export function counters(samples) {
  const c = { reqs: 0, err_4xx: 0, err_5xx: 0, read: new Map(), checkout: new Map() };
  for (const s of samples) {
    if (/^\/(metrics|readyz|healthz)$/.test(s.labels.route ?? '')) continue;
    if (s.name === `${P}http_request_duration_seconds_count`) {
      const status = Number(s.labels.status);
      c.reqs += s.value;
      if (status >= 500) c.err_5xx += s.value;
      else if (status >= 400) c.err_4xx += s.value;
    }
    const g = s.name === `${P}http_request_duration_seconds_bucket` && groupOf(s.labels);
    if (g) {
      const le = Number(s.labels.le === '+Inf' ? Infinity : s.labels.le);
      c[g].set(le, (c[g].get(le) ?? 0) + s.value);
    }
  }
  return c;
}

/** Prometheus-style histogram_quantile over the bucket deltas of one interval, in milliseconds. */
export function quantileMs(q, now, before = new Map()) {
  const les = [...now.keys()].sort((a, b) => a - b);
  const delta = (le) => (now.get(le) ?? 0) - (before.get(le) ?? 0);
  const total = delta(Infinity);
  if (!(total > 0)) return '';
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const le of les) {
    const count = delta(le);
    if (count >= rank) {
      if (le === Infinity) return String(prevLe * 1000); // beyond the last finite bucket
      return (
        (prevLe + ((le - prevLe) * (rank - prevCount)) / Math.max(count - prevCount, 1)) *
        1000
      ).toFixed(1);
    }
    prevLe = le;
    prevCount = count;
  }
  return '';
}

async function dbStats(url) {
  const { Client } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid())::int AS pg_conns,
      (SELECT count(*) FROM processed_events)::int AS processed_events,
      (SELECT count(*) FROM orders)::int AS orders`);
    return rows[0];
  } finally {
    await client.end();
  }
}

async function sample(base, dbUrl, startedAt, prev) {
  const row = { ts: new Date().toISOString(), elapsed_min: ((Date.now() - startedAt) / 60_000).toFixed(1) };
  const [metrics, ready, db] = await Promise.allSettled([
    fetch(`${base}/metrics`).then((r) => r.text()),
    fetch(`${base}/readyz`).then(async (r) => ({ ok: r.ok, body: await r.json() })),
    dbStats(dbUrl),
  ]);
  let now;
  if (metrics.status === 'fulfilled') {
    const samples = parseMetrics(metrics.value);
    const v = (name) => samples.find((s) => s.name === P + name)?.value;
    row.rss_mb = (v('process_resident_memory_bytes') / MB).toFixed(1);
    row.heap_used_mb = (v('nodejs_heap_size_used_bytes') / MB).toFixed(1);
    row.heap_total_mb = (v('nodejs_heap_size_total_bytes') / MB).toFixed(1);
    row.external_mb = (v('nodejs_external_memory_bytes') / MB).toFixed(1);
    row.el_lag_p99_ms = (v('nodejs_eventloop_lag_p99_seconds') * 1000).toFixed(1);
    row.handles = v('nodejs_active_handles_total');
    now = counters(samples);
    if (prev) {
      for (const k of ['reqs', 'err_4xx', 'err_5xx']) row[k] = now[k] - prev[k];
      row.read_p95_ms = quantileMs(0.95, now.read, prev.read);
      row.checkout_p95_ms = quantileMs(0.95, now.checkout, prev.checkout);
    }
  }
  if (ready.status === 'fulfilled') {
    row.ready = ready.value.ok ? 1 : 0;
    row.outbox_pending = ready.value.body.outbox?.pending;
    row.outbox_oldest_s = ready.value.body.outbox?.oldestSeconds;
  } else row.ready = 0;
  if (db.status === 'fulfilled') Object.assign(row, db.value);
  return { row, counters: now ?? prev };
}

async function monitor(file) {
  const base = process.env.BASE_URL ?? 'http://localhost:4000';
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const minutes = Number(process.env.MINUTES ?? Infinity);
  const intervalMs = Number(process.env.INTERVAL_S ?? 60) * 1000;
  if (!existsSync(file)) appendFileSync(file, `${COLUMNS.join(',')}\n`);
  const startedAt = Date.now();
  let prev;
  for (let next = startedAt; Date.now() - startedAt <= minutes * 60_000; next += intervalMs) {
    const s = await sample(base, dbUrl, startedAt, prev);
    prev = s.counters;
    appendFileSync(file, `${COLUMNS.map((c) => s.row[c] ?? '').join(',')}\n`);
    await new Promise((r) => setTimeout(r, Math.max(0, next + intervalMs - Date.now())));
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

/** Growth rules: median of the last third of the steady state against the first third. */
const RULES = [
  ['rss_mb', (a, b) => b <= a * 1.25 + 16],
  ['heap_used_mb', (a, b) => b <= a * 1.25 + 8],
  ['handles', (a, b) => b <= a * 1.25 + 10],
  ['pg_conns', (a, b) => b <= a + 2],
  ['outbox_pending', (a, b) => b <= a + 20],
];

export function check(csv, warmupMin) {
  const [head, ...lines] = csv.trim().split('\n');
  const cols = head.split(',');
  const rows = lines.map((l) =>
    Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? NaN : Number(v)])),
  );
  const steady = rows.filter((r) => r.elapsed_min >= warmupMin);
  if (steady.length < 6) return { ok: false, report: [`only ${steady.length} samples after warm-up`] };
  const third = Math.floor(steady.length / 3);
  const pick = (rs, k) => rs.map((r) => r[k]).filter(Number.isFinite);
  const report = [];
  let ok = true;
  for (const [k, rule] of RULES) {
    const a = median(pick(steady.slice(0, third), k));
    const b = median(pick(steady.slice(-third), k));
    const pass = Number.isFinite(a) && Number.isFinite(b) && rule(a, b);
    ok &&= pass;
    report.push(
      `${pass ? 'PASS' : 'FAIL'} ${k}: first-third median ${a}, last-third median ${b}, max ${Math.max(...pick(steady, k))}`,
    );
  }
  const sum = (k) => pick(rows, k).reduce((x, y) => x + y, 0);
  const notReady = rows.filter((r) => r.ready === 0).length;
  ok &&= notReady === 0;
  report.push(`${notReady ? 'FAIL' : 'PASS'} readiness: ${notReady} of ${rows.length} samples not ready`);
  report.push(
    `INFO ${sum('reqs')} requests, ${sum('err_4xx')} 4xx, ${sum('err_5xx')} 5xx, ${rows.length} samples`,
  );
  return { ok, report };
}

const { values, positionals } = parseArgs({
  options: { check: { type: 'boolean' }, 'warmup-min': { type: 'string', default: '30' } },
  allowPositionals: true,
});
const file = positionals[0];
if (!file) throw new Error('usage: soak-monitor.mjs [--check] <file.csv>');
if (values.check) {
  const { ok, report } = check(readFileSync(file, 'utf8'), Number(values['warmup-min']));
  console.log(report.join('\n'));
  process.exitCode = ok ? 0 : 1;
} else {
  await monitor(file);
}
