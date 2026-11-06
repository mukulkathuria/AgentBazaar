export const dynamic = 'force-dynamic';

/** Liveness for the container HEALTHCHECK. Does not depend on the API. */
export function GET(): Response {
  return Response.json({ ok: true });
}
