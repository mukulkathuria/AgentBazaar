// node --test tests/load/soak-monitor.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, counters, parseMetrics, quantileMs } from './soak-monitor.mjs';

const histogram = (route, counts) =>
  [0.05, 0.1, 0.3, Infinity]
    .map(
      (le, i) =>
        `agentbazaar_http_request_duration_seconds_bucket{le="${le === Infinity ? '+Inf' : le}",method="GET",route="${route}",status="200"} ${counts[i]}`,
    )
    .join('\n');

test('per-minute p95 interpolates inside the bucket that holds it, like histogram_quantile', () => {
  const before = counters(parseMetrics(histogram('/api/v1/products', [0, 0, 0, 0])));
  const now = counters(parseMetrics(histogram('/api/v1/products', [50, 90, 100, 100])));
  // 95th of 100 requests: 5 of the 10 requests between 100 and 300 ms -> 200 ms.
  assert.equal(quantileMs(0.95, now.read, before.read), '200.0');
  assert.equal(quantileMs(0.95, now.checkout, before.checkout), '');
});

const csv = (rows) =>
  [
    'elapsed_min,ready,rss_mb,heap_used_mb,pg_conns,outbox_pending,handles,reqs,err_4xx,err_5xx',
    ...rows,
  ].join('\n');
const steady = (n, rss) => Array.from({ length: n }, (_, i) => `${30 + i},1,${rss(i)},50,5,0,90,2000,0,0`);

test('check passes flat memory and fails steady growth after warm-up', () => {
  assert.equal(check(csv(steady(30, () => 150)), 30).ok, true);
  assert.equal(check(csv(steady(30, (i) => 150 + i * 5)), 30).ok, false);
});

test('idle samples after the load stopped do not hide growth', () => {
  const idle = Array.from({ length: 30 }, (_, i) => `${60 + i},1,100,40,1,0,6,0,0,0`);
  assert.equal(check(csv([...steady(30, (i) => 150 + i * 5), ...idle]), 30).ok, false);
});

test('check fails a run that was not ready', () => {
  const rows = steady(30, () => 150);
  rows[10] = rows[10].replace(/^(\d+),1,/, '$1,0,');
  assert.equal(check(csv(rows), 30).ok, false);
});
