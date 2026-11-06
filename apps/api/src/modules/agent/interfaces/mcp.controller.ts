import { Controller, Delete, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '@agentbazaar/config';
import { ALL_AGENT_SCOPES, MCP_TOOL_SCOPES, McpToolInputs, type McpToolName } from '@agentbazaar/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertRequirement, Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { CONFIG } from '../../../shared/kernel/tokens.js';
import { McpTools, type ToolOutcome } from '../application/mcp-tools.js';
import { hijack } from './raw-reply.js';

const INSTRUCTIONS =
  'Seller tools for an Indian online store. Prices are in rupees and include GST. Typical flow: search_products -> get_product -> ' +
  'request_quote -> make_offer (optional, limited rounds) -> accept_quote -> create_checkout_link, then give the link to your user: ' +
  'a person must open it to confirm the address and pay. Quotes are signed, single-use and expire; the seller never goes below its policy.';

const toResult = (o: ToolOutcome): CallToolResult =>
  o.ok
    ? { structuredContent: o.data, content: [{ type: 'text', text: o.summary }] }
    : { isError: true, structuredContent: { error: { code: o.code, message: o.message } }, content: [{ type: 'text', text: o.message }] };

function toolCalled(message: unknown): McpToolName | null {
  if (typeof message !== 'object' || message === null) return null;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
  const name = params?.name;
  return method === 'tools/call' && typeof name === 'string' && Object.hasOwn(MCP_TOOL_SCOPES, name) ? (name as McpToolName) : null;
}

/**
 * MCP over Streamable HTTP, stateless: a fresh server and transport per request, tools bound to the
 * caller's principal. Quotas are enforced per request by the global auth guard.
 */
@Controller()
export class McpController {
  private readonly resourceMetadataUrl: string;

  constructor(
    @Inject(McpTools) private readonly tools: McpTools,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.resourceMetadataUrl = `${config.env.PUBLIC_API_URL}/.well-known/oauth-protected-resource/mcp`;
  }

  @Post('mcp')
  @Auth('public')
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @CurrentPrincipal() who: Principal): Promise<void> {
    this.challenge(req.body, who, reply);
    const server = this.server(who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const raw = hijack(req, reply);
    raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, raw, req.body);
    } catch {
      if (!raw.headersSent) raw.writeHead(500, { 'content-type': 'application/json' });
      if (!raw.writableEnded) raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }

  @Get('mcp')
  @Auth('public')
  get(@Res() reply: FastifyReply) {
    return this.methodNotAllowed(reply);
  }

  @Delete('mcp')
  @Auth('public')
  delete(@Res() reply: FastifyReply) {
    return this.methodNotAllowed(reply);
  }

  /** RFC 9728 metadata so MCP clients can discover where to get a token and which scopes exist. */
  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'])
  @Auth('public')
  resourceMetadata() {
    const env = this.config.env;
    return {
      resource: `${env.PUBLIC_API_URL}/mcp`,
      authorization_servers: [this.config.adapters.identity === 'oidc' && env.OIDC_ISSUER_URL ? env.OIDC_ISSUER_URL : env.PUBLIC_API_URL],
      scopes_supported: [...ALL_AGENT_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: `${env.SELLER_NAME} MCP server`,
    };
  }

  /**
   * A tool call the token's scopes cannot cover is refused at the HTTP layer with a Bearer challenge
   * (401 without a token, 403 insufficient_scope with one), so clients can start or step up OAuth.
   */
  private challenge(body: unknown, who: Principal, reply: FastifyReply): void {
    for (const message of Array.isArray(body) ? body : [body]) {
      const tool = toolCalled(message);
      const scope = tool ? MCP_TOOL_SCOPES[tool] : null;
      if (!scope || who.scopes.has(scope)) continue;
      const error = who.kind === 'anonymous' ? '' : 'error="insufficient_scope", ';
      void reply.header('www-authenticate', `Bearer ${error}scope="${scope}", resource_metadata="${this.resourceMetadataUrl}"`);
      assertRequirement(who, scope);
    }
  }

  private server(who: Principal): McpServer {
    const server = new McpServer(
      { name: 'agentbazaar', title: this.config.env.SELLER_NAME, version: '0.9.0' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    for (const name of Object.keys(McpToolInputs) as McpToolName[]) {
      const tool = this.tools.tools[name];
      server.registerTool(
        name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: McpToolInputs[name],
          annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
        },
        // The SDK has already validated `args` against this tool's schema.
        async (args: unknown) => toResult(await this.tools.call(name, args as never, who)),
      );
    }
    return server;
  }

  private methodNotAllowed(reply: FastifyReply) {
    return reply
      .status(405)
      .header('allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server is stateless, use POST.' }, id: null });
  }
}
