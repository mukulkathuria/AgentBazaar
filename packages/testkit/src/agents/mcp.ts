import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** One tool call as a buyer agent sees it. `httpStatus` is set when the server refused at the HTTP layer. */
export interface ToolCall {
  ok: boolean;
  data: Record<string, unknown>;
  text: string;
  httpStatus?: number;
}

export interface McpConnection {
  call(tool: string, args: Record<string, unknown>): Promise<ToolCall>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/** Connects with the official MCP client over Streamable HTTP, optionally with a bearer token. */
export async function connectMcp(url: string, token?: string): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  const client = new Client({ name: 'agentbazaar-testkit-buyer', version: '0.9.0' });
  await client.connect(transport);
  return {
    async call(tool, args) {
      try {
        const r = await client.callTool({ name: tool, arguments: args });
        const content = (r.content ?? []) as { type: string; text?: string }[];
        return {
          ok: r.isError !== true,
          data: (r.structuredContent ?? {}) as Record<string, unknown>,
          text: content.map((c) => c.text ?? '').join('\n'),
        };
      } catch (err) {
        // Transport errors carry the HTTP status as `code` (401, 403, 429); protocol errors use negative codes.
        const code = (err as { code?: unknown }).code;
        return { ok: false, data: {}, text: (err as Error).message, ...(typeof code === 'number' && code > 0 ? { httpStatus: code } : {}) };
      }
    },
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    close: () => client.close(),
  };
}
