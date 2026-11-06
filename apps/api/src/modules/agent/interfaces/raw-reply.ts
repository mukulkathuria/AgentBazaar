import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Takes the response over from Fastify (for streaming), keeping the security, CORS and request-id headers already set. */
export function hijack(req: FastifyRequest, reply: FastifyReply): ServerResponse {
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
  reply.raw.setHeader('x-request-id', req.id);
  return reply.raw;
}
