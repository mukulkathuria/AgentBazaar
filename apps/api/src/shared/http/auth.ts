import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_AGENT_SCOPES, type AgentScope, type Role } from '@agentbazaar/contracts';
import type { FastifyRequest } from 'fastify';
import type { Cache } from '../cache/cache.js';
import { sha256Hex } from '../crypto/primitives.js';
import { AppError } from '../kernel/errors.js';
import { CACHE } from '../kernel/tokens.js';

export type Principal =
  | { kind: 'anonymous'; subject: string; scopes: ReadonlySet<AgentScope> }
  | {
      kind: 'customer';
      subject: string;
      userId: string;
      customerToken: string;
      role: Role;
      mfa: boolean;
      scopes: ReadonlySet<AgentScope>;
    }
  | { kind: 'agent'; subject: string; clientId: string; scopes: ReadonlySet<AgentScope>; quotaPerMinute: number };

export type AuthRequirement = 'public' | 'optional' | 'customer' | 'admin' | AgentScope;

/** Verifies bearer tokens. Built-in issuer in lite, Keycloak/OIDC from growth. */
export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
export interface AuthOptions {
  /** DEMO_MODE: anonymous callers get every buyer scope (mock payments only). */
  anonymousScopes: readonly AgentScope[];
}

const AUTH_KEY = 'agentbazaar:auth';
export const Auth = (requirement: AuthRequirement) => SetMetadata(AUTH_KEY, requirement);

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.principal) throw new AppError('unauthorized', 'Not authenticated');
  return req.principal;
});

export function anonymousPrincipal(ip: string, scopes: readonly AgentScope[]): Principal {
  return { kind: 'anonymous', subject: `anon:${sha256Hex(ip).slice(0, 16)}`, scopes: new Set(scopes) };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/.exec(header.trim());
  if (!m) throw new AppError('unauthorized', 'Malformed Authorization header');
  return m[1]!;
}

/** Resolves the caller once per request; shared by the REST guard and the MCP/A2A routes. */
export async function resolvePrincipal(
  req: FastifyRequest,
  verifier: TokenVerifier,
  opts: AuthOptions,
): Promise<Principal> {
  const token = bearerToken(req.headers.authorization);
  return token ? verifier.verify(token) : anonymousPrincipal(req.ip, opts.anonymousScopes);
}

export function assertRequirement(principal: Principal, requirement: AuthRequirement): void {
  switch (requirement) {
    case 'public':
    case 'optional':
      return;
    case 'customer':
      if (principal.kind !== 'customer') throw new AppError('unauthorized', 'Sign in to continue');
      return;
    case 'admin':
      if (principal.kind !== 'customer') throw new AppError('unauthorized', 'Sign in to continue');
      if (principal.role !== 'admin') throw new AppError('forbidden', 'Admins only');
      if (!principal.mfa) throw new AppError('forbidden', 'Admin access needs a session verified with MFA');
      return;
    default:
      if (!principal.scopes.has(requirement)) {
        if (principal.kind === 'anonymous') {
          throw new AppError('unauthorized', `This action needs the "${requirement}" scope. Authenticate with an agent token.`);
        }
        throw new AppError('forbidden', `Token is missing the "${requirement}" scope`);
      }
  }
}

/** Per-agent quota: a fixed one-minute window counter in the shared cache. */
export async function enforceAgentQuota(principal: Principal, cache: Cache, nowMs: number): Promise<void> {
  if (principal.kind !== 'agent') return;
  const window = Math.floor(nowMs / 60_000);
  const used = await cache.incr(`quota:${principal.clientId}:${window}`, 61);
  if (used > principal.quotaPerMinute) {
    throw new AppError('rate_limited', `Agent quota of ${principal.quotaPerMinute} requests per minute exceeded`);
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(AUTH_OPTIONS) private readonly opts: AuthOptions,
    @Inject(CACHE) private readonly cache: Cache,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement =
      this.reflector.getAllAndOverride<AuthRequirement | undefined>(AUTH_KEY, [ctx.getHandler(), ctx.getClass()]) ?? 'public';
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const principal = await resolvePrincipal(req, this.verifier, this.opts);
    assertRequirement(principal, requirement);
    await enforceAgentQuota(principal, this.cache, Date.now());
    req.principal = principal;
    return true;
  }
}

export const ALL_SCOPES = ALL_AGENT_SCOPES;
