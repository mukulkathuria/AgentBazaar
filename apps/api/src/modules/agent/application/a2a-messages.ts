import { randomUUID } from 'node:crypto';
import { type AgentCard, type AgentSkill, type Message, type Part, Role } from '@a2a-js/sdk';
import type { AppConfig } from '@agentbazaar/config';
import { A2AInbound, ALL_AGENT_SCOPES } from '@agentbazaar/contracts';
import { publicError } from './views.js';

/** Key under which the request's principal travels in the A2A ServerCallContext state. */
export const PRINCIPAL_STATE = 'agentbazaar.principal';

const MODES = ['application/json', 'text/plain'];

const skill = (id: string, name: string, description: string, tags: string[], examples: string[]): AgentSkill => ({
  id,
  name,
  description,
  tags,
  examples,
  inputModes: MODES,
  outputModes: MODES,
  securityRequirements: [],
});

/** A2A v1.0 agent card. A v0.3 JSON-RPC interface is also declared for agents still on `message/send`. */
export function agentCard(config: AppConfig): AgentCard {
  const env = config.env;
  const url = `${env.PUBLIC_API_URL}/a2a`;
  return {
    name: `${env.SELLER_NAME} seller agent`,
    description:
      'Seller agent for an Indian online store. Search the catalog, negotiate prices inside the seller policy with structured ' +
      'offers (INR, GST included) and receive a signed checkout link that a person opens to pay.',
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
      { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3', tenant: '' },
    ],
    provider: { organization: env.SELLER_NAME, url: env.PUBLIC_WEB_URL },
    version: '0.9.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: { description: `Agent access token from ${env.PUBLIC_API_URL}`, scheme: 'Bearer', bearerFormat: 'JWT' },
        },
      },
    },
    // Demo mode serves anonymous agents with every scope, so a token is optional there.
    securityRequirements: env.DEMO_MODE ? [] : [{ schemes: { bearer: { list: [...ALL_AGENT_SCOPES] } } }],
    defaultInputModes: MODES,
    defaultOutputModes: MODES,
    skills: [
      skill('catalog_search', 'Catalog search', 'Ask in plain text for products, prices, stock, compatibility or personalisation options.', ['search', 'catalog', 'products'], [
        'Show me graphics cards under 60000 rupees',
        'Is the THOCK-TK87-RED keyboard in stock?',
      ]),
      skill(
        'negotiate',
        'Negotiate a price',
        'Send a DataPart {"type":"quote_request","sku":"…","quantity":1} for a signed quote, then {"type":"offer","negotiation_id":"…",' +
          '"unit_price":{"amount":"1800.00","currency":"INR"}} to counter. Replies carry a DataPart of type "quote".',
        ['negotiation', 'quote', 'offer'],
        ['{"type":"quote_request","sku":"THOCK-TK87-RED","quantity":2}'],
      ),
      skill(
        'checkout_handoff',
        'Checkout handoff',
        'Send {"type":"accept","quote_token":"…"} to lock the price and get a DataPart of type "checkout" with a signed URL a person opens to pay.',
        ['checkout', 'payment'],
        ['{"type":"accept","quote_token":"<token from a quote>"}'],
      ),
    ],
    signatures: [],
  };
}

export const dataPart = (value: Record<string, unknown>): Part => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
export const textPart = (value: string): Part => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

export const agentMessage = (contextId: string, parts: Part[]): Message => ({
  messageId: randomUUID(),
  contextId,
  taskId: '',
  role: Role.ROLE_AGENT,
  parts,
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

export interface Inbound {
  data: A2AInbound[];
  text: string;
  invalid: string[];
}

/** Splits a buyer agent's message into structured requests (DataParts) and free text. Files are ignored. */
export function readInbound(parts: readonly Part[]): Inbound {
  const out: Inbound = { data: [], text: '', invalid: [] };
  const text: string[] = [];
  for (const { content } of parts) {
    if (content?.$case === 'text') text.push(content.value);
    if (content?.$case !== 'data') continue;
    const parsed = A2AInbound.safeParse(content.value);
    if (parsed.success) out.data.push(parsed.data);
    else out.invalid.push(parsed.error.issues.map((i) => `${i.path.join('.') || 'data'}: ${i.message}`).join('; '));
  }
  out.text = text.join('\n').trim();
  return out;
}

/** Error reply: a machine-readable DataPart plus the same safe message as text. */
export function errorParts(err: unknown): Part[] {
  const e = publicError(err);
  return [dataPart({ type: 'error', ...e }), textPart(e.message)];
}
