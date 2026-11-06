// promptfoo extension hook. Chat turns that name the same `conversation` share one chat session (run the
// evals with -j 1 so turns stay in order), and each turn sees the prices already quoted in its conversation.
// MCP make_offer tests get a fresh negotiation from request_quote first.
import { randomUUID } from 'node:crypto';
import { paiseIn } from './policy.mjs';

const API = (process.env.API_URL ?? 'http://localhost:4113').replace(/\/+$/, '');
const conversations = new Map();

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function conversation(id, language) {
  if (!conversations.has(id)) {
    const { sessionId } = await post('/api/v1/chat/sessions', { language });
    conversations.set(id, { sessionId, paise: [] });
  }
  return conversations.get(id);
}

async function negotiationId(sku) {
  const rpc = await post('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'request_quote', arguments: { sku, quantity: 1 } },
  });
  const id = rpc.result?.structuredContent?.negotiation_id;
  if (!id) throw new Error(`request_quote for ${sku} returned no negotiation: ${JSON.stringify(rpc)}`);
  return id;
}

export async function extensionHook(hookName, context) {
  if (hookName === 'beforeEach') {
    const vars = { ...context.test.vars, apiUrl: API };
    if (vars.message !== undefined) {
      const c = await conversation(vars.conversation ?? randomUUID(), vars.language ?? 'en');
      Object.assign(vars, { sessionId: c.sessionId, seenPaise: JSON.stringify(c.paise) });
    }
    if (vars.tool === 'make_offer')
      vars.args = { ...vars.args, negotiation_id: await negotiationId(vars.sku) };
    return { test: { ...context.test, vars } };
  }
  if (hookName === 'afterEach') {
    const c = conversations.get(context.test.vars?.conversation);
    const output = context.result?.response?.output;
    if (c && typeof output === 'string') c.paise.push(...paiseIn(JSON.parse(output)));
  }
  return undefined;
}
