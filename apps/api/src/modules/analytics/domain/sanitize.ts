import { redact } from '../../../shared/observability/redact.js';

export type EventValue = string | number | boolean | null;

const MAX_TEXT = 100;
const MAX_KEYS = 20;

/**
 * Event data stays small, flat and free of personal data: strings are redacted then cut to 100
 * characters, non-finite numbers and nested values are dropped.
 */
export function sanitizeEventData(data: Readonly<Record<string, unknown>>): Record<string, EventValue> {
  const out: Record<string, EventValue> = {};
  for (const [key, value] of Object.entries(data).slice(0, MAX_KEYS)) {
    if (typeof value === 'string') out[key] = redact(value).slice(0, MAX_TEXT);
    else if (typeof value === 'boolean' || value === null || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

/** Page paths lose their query string and fragment (checkout and order tokens travel there). */
export const cleanPath = (path: string): string => redact(path.split(/[?#]/, 1)[0] ?? '').slice(0, 200);
