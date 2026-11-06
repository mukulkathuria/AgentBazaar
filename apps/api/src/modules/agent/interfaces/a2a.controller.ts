import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { AgentCard, Extensions, formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS } from '@a2a-js/sdk';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import {
  type DefaultRequestHandler,
  defaultServerCallContextBuilder,
  JsonRpcTransportHandler,
  type User,
  validateVersion,
} from '@a2a-js/sdk/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { PRINCIPAL_STATE } from '../application/a2a-messages.js';
import { hijack } from './raw-reply.js';

export const A2A_HANDLER = Symbol('A2A_HANDLER');

type RpcError = { code: number; message: string };
type RpcId = string | number | null;

class PrincipalUser implements User {
  constructor(private readonly principal: Principal) {}
  get isAuthenticated(): boolean {
    return this.principal.kind !== 'anonymous';
  }
  get userName(): string {
    return this.principal.subject;
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v : undefined;
};

const isStream = (r: unknown): r is AsyncGenerator<unknown> =>
  typeof r === 'object' && r !== null && typeof (r as AsyncGenerator)[Symbol.asyncIterator] === 'function';

/**
 * A2A over JSON-RPC on Fastify: the SDK's Express glue (`jsonRpcHandler`) replicated, with the
 * principal from our auth guard. Requests without `A2A-Version`, or with 0.3, use the v0.3 compat
 * handler so agents still speaking `message/send` work too.
 */
@Controller()
export class A2aController {
  private readonly v1: JsonRpcTransportHandler;
  private readonly legacy: LegacyJsonRpcTransportHandler;

  constructor(@Inject(A2A_HANDLER) private readonly handler: DefaultRequestHandler) {
    this.v1 = new JsonRpcTransportHandler(handler);
    this.legacy = new LegacyJsonRpcTransportHandler(handler);
  }

  @Get('.well-known/agent-card.json')
  @Auth('public')
  async card(@Res() reply: FastifyReply): Promise<void> {
    await reply.header('cache-control', 'public, max-age=300').send(AgentCard.toJSON(await this.handler.getAgentCard()));
  }

  @Post('a2a')
  @Auth('public')
  async rpc(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @CurrentPrincipal() who: Principal): Promise<void> {
    const version = header(req, 'a2a-version');
    const legacy = (version ?? '0.3') === '0.3';
    const id = (req.body as { id?: RpcId } | null)?.id ?? null;
    const mapError = (err: unknown): RpcError =>
      legacy ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError(err) : JsonRpcTransportHandler.mapToJSONRPCError(err);
    try {
      const context = defaultServerCallContextBuilder({
        extensions: Extensions.parseServiceParameter(header(req, legacy ? 'x-a2a-extensions' : 'a2a-extensions')),
        user: new PrincipalUser(who),
        headers: req.headers,
        ...(version ? { requestedVersion: version } : {}),
      });
      context.state.set(PRINCIPAL_STATE, who);
      validateVersion(context.requestedVersion, await this.handler.getAgentCard(), 'JSONRPC');
      const result = await (legacy ? this.legacy : this.v1).handle(req.body as Record<string, unknown>, context);
      if (context.activatedExtensions) void reply.header(legacy ? 'x-a2a-extensions' : 'a2a-extensions', context.activatedExtensions.join(','));
      if (isStream(result)) return await this.stream(req, reply, result, { id, mapError });
      await reply.status(200).send(result);
    } catch (err) {
      const error = mapError(err);
      await reply.status(error.code === -32603 ? 500 : 200).send({ jsonrpc: '2.0', id, error });
    }
  }

  /** The first event is awaited before switching to SSE, so an early failure is still a plain JSON-RPC error. */
  private async stream(req: FastifyRequest, reply: FastifyReply, events: AsyncGenerator<unknown>, rpc: { id: RpcId; mapError: (e: unknown) => RpcError }) {
    let first: IteratorResult<unknown>;
    try {
      first = await events.next();
    } catch (err) {
      await reply.status(200).send({ jsonrpc: '2.0', id: rpc.id, error: rpc.mapError(err) });
      return;
    }
    const raw = hijack(req, reply);
    raw.writeHead(200, SSE_HEADERS);
    try {
      for (let next = first; !next.done; next = await events.next()) raw.write(formatSSEEvent(next.value));
    } catch (err) {
      raw.write(formatSSEErrorEvent({ jsonrpc: '2.0', id: rpc.id, error: rpc.mapError(err) }));
    } finally {
      raw.end();
    }
  }
}
