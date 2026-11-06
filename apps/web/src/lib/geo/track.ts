import { Routes } from '@agentbazaar/contracts';
import { API_URL } from '../env';
import type { Visit } from './detect';

/** Fire-and-forget GEO analytics. Sends the bot or AI site name and the path only: no IP, cookies or query. */
export async function trackVisit(visit: Visit, path: string): Promise<void> {
  const key = process.env.ANALYTICS_INGEST_KEY;
  try {
    await fetch(new URL(Routes.trackEvent.path, API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-ingest-key': key } : {}) },
      body: JSON.stringify({ kind: visit.kind, agent: visit.agent, path: path.slice(0, 500) }),
      signal: AbortSignal.timeout(2_000),
      cache: 'no-store',
    });
  } catch {
    // Analytics must never affect the page.
  }
}
