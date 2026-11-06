import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Endpoints of tests/infra/data-tier.yml. Its suites opt in with DATA_TIER=1, because the shared Services
 * workflow does not start that stack (.github/workflows/data-tier.yml does).
 */
export const DATA_TIER = Boolean(process.env.DATA_TIER);
export const PRIMARY_URL = 'postgres://postgres:postgres@localhost:56432/postgres';
export const PGBOUNCER_URL = 'postgres://postgres:postgres@localhost:56433/postgres';
export const REPLICA_URL = 'postgres://postgres:postgres@localhost:56434/postgres';
export const STANDBY_URL = 'postgres://postgres:postgres@localhost:56435/postgres';

/** The same server and credentials, another database or port. */
export function withUrl(url: string, change: { database?: string; port?: string }): string {
  const u = new URL(url);
  if (change.database) u.pathname = `/${change.database}`;
  if (change.port) u.port = change.port;
  return u.toString();
}

/**
 * Runs a Docker CLI command: `docker` by default, or DATA_TIER_DOCKER (e.g. `wsl.exe -d Debian --exec docker`).
 * Asynchronous on purpose: a blocked event loop would stall the workload a drill is measuring.
 */
export async function docker(...args: string[]): Promise<string> {
  const [cmd, ...prefix] = (process.env.DATA_TIER_DOCKER ?? 'docker').split(' ');
  return (await promisify(execFile)(cmd!, [...prefix, ...args], { encoding: 'utf8' })).stdout;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `done` until it holds, failing with `what` after `timeoutMs`. */
export async function waitFor(what: string, done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}
