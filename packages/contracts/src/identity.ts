import { z } from 'zod';
import { Uuid } from './common.js';

export const AgentScope = z.enum(['catalog:read', 'quote:create', 'order:create']);
export type AgentScope = z.infer<typeof AgentScope>;
export const ALL_AGENT_SCOPES: readonly AgentScope[] = AgentScope.options;

export const Role = z.enum(['customer', 'admin']);
export type Role = z.infer<typeof Role>;

export const Password = z
  .string()
  .min(10, { error: 'Use at least 10 characters' })
  .max(128)
  // A regex rather than a refine, so the OpenAPI document (and the API fuzzer) carries the rule too.
  .regex(/[a-zA-Z][\s\S]*\d|\d[\s\S]*[a-zA-Z]/, { error: 'Use letters and numbers' });

export const RegisterInput = z.strictObject({
  email: z.email().max(200),
  password: Password,
  name: z.string().trim().min(2).max(100),
  consents: z.strictObject({
    terms: z.literal(true, { error: 'You must accept the terms' }),
    marketing: z.boolean().default(false),
  }),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.strictObject({
  email: z.email().max(200),
  password: z.string().min(1).max(128),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const TokenResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int(),
  refreshToken: z.string().optional(),
  role: Role.optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const ClientCredentialsInput = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(3).max(100),
  client_secret: z.string().min(16).max(200),
  scope: z.string().max(200).optional(),
});

export const OAuthTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  scope: z.string(),
});

export const CreateAgentClientInput = z.strictObject({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(AgentScope).min(1),
  quotaPerMinute: z.number().int().min(1).max(10_000).default(60),
});

export const AgentClientView = z.object({
  id: Uuid,
  clientId: z.string(),
  name: z.string(),
  scopes: z.array(AgentScope),
  quotaPerMinute: z.number().int(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  /** Returned exactly once, at creation. */
  clientSecret: z.string().optional(),
});

export const ConsentPurpose = z.enum(['terms', 'order_fulfilment', 'marketing', 'analytics']);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

export const ConsentUpdate = z.strictObject({ purpose: ConsentPurpose, granted: z.boolean() });

export const ConsentView = z.object({
  purpose: ConsentPurpose,
  granted: z.boolean(),
  noticeVersion: z.string(),
  at: z.string(),
});
export type ConsentView = z.infer<typeof ConsentView>;

export const MeView = z.object({
  customerToken: z.string(),
  role: Role,
  name: z.string().nullable(),
  email: z.string().nullable(),
  mfaEnabled: z.boolean(),
  consents: z.array(ConsentView),
});
export type MeView = z.infer<typeof MeView>;
