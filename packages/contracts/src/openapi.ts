import { z } from 'zod';
import { ErrorBody } from './common.js';
import { Routes, type RouteDef } from './routes.js';

type JsonSchema = Record<string, unknown>;

function schemaOf(type: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(type, { target: 'draft-2020-12', io, unrepresentable: 'any' });
  return rest;
}

function parameters(def: RouteDef): JsonSchema[] {
  const out: JsonSchema[] = [];
  const add = (obj: z.ZodType | undefined, where: 'path' | 'query') => {
    if (!obj) return;
    const json = schemaOf(obj, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      out.push({ name, in: where, required: where === 'path' || (json.required ?? []).includes(name), schema });
    }
  };
  add(def.params, 'path');
  add(def.query, 'query');
  if (def.idempotent) {
    // Same rule as apps/api/src/shared/http/idempotency.ts.
    out.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' } });
  }
  return out;
}

/** Builds the OpenAPI 3.1 document from the route registry. Output is deterministic. */
export function buildOpenApi(version: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const error = { description: 'Error', content: { 'application/json': { schema: schemaOf(ErrorBody, 'output') } } };
  for (const [operationId, def] of Object.entries(Routes) as [string, RouteDef][]) {
    const op: JsonSchema = {
      operationId,
      summary: def.summary,
      tags: [def.tag],
      parameters: parameters(def),
      responses: {
        [String(def.status ?? 200)]: {
          description: 'OK',
          content: { 'application/json': { schema: schemaOf(def.response, 'output') } },
        },
        '400': error,
        '401': error,
        '403': error,
        '404': error,
        '409': error,
        // Transport limits: request body over 256 KB, path parameter over 256 characters.
        ...(def.method === 'get' ? {} : { '413': error }),
        ...(def.params ? { '414': error } : {}),
        '429': error,
        '431': { description: 'Request line and headers over 16 KB, rejected by the HTTP server before the API runs' },
      },
    };
    if (def.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(def.body, 'input') } } };
    }
    if (def.auth !== 'public') op.security = def.auth === 'optional' ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }];
    if (def.auth === 'quote:create' || def.auth === 'order:create') op['x-required-scope'] = def.auth;
    (paths[def.path] ??= {})[def.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentBazaar API',
      version,
      description: 'REST surface of AgentBazaar. Agents can also use MCP at /mcp and A2A at /a2a.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'http://localhost:4000' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    paths,
  };
}

/** "/api/v1/products/{slug}" -> "/api/v1/products/:slug" (Fastify style). */
export function toFastifyPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}
