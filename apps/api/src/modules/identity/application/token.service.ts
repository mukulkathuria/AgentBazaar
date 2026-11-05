import { randomUUID } from 'node:crypto';
import { type AgentScope, AgentScope as AgentScopeSchema, type Role } from '@agentbazaar/contracts';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { KeyRing } from '../../../shared/crypto/keyring.js';
import type { Principal, TokenVerifier } from '../../../shared/http/auth.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import { AppError } from '../../../shared/kernel/errors.js';

const CUSTOMER_TTL_S = 15 * 60;
const AGENT_TTL_S = 15 * 60;
const ALL: AgentScope[] = ['catalog:read', 'quote:create', 'order:create'];

interface Claims extends JWTPayload {
  typ: 'customer' | 'agent';
  role?: Role;
  ctk?: string;
  scope?: string;
  qpm?: number;
  amr?: string[];
}

export function parseScopes(scope: string | undefined): Set<AgentScope> {
  const out = new Set<AgentScope>();
  for (const s of (scope ?? '').split(/\s+/)) {
    const r = AgentScopeSchema.safeParse(s);
    if (r.success) out.add(r.data);
  }
  return out;
}

/** Built-in issuer for lite: EdDSA access tokens for customers and agent clients. */
export class TokenService implements TokenVerifier {
  constructor(
    private readonly keys: KeyRing,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly clock: Clock,
  ) {}

  private sign(claims: Claims, subject: string, ttl: number): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(randomUUID())
      .sign(this.keys.jwtPrivateKey);
  }

  async issueCustomer(p: { userId: string; customerToken: string; role: Role; mfa: boolean }): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.sign(
      { typ: 'customer', role: p.role, ctk: p.customerToken, amr: p.mfa ? ['pwd', 'otp'] : ['pwd'] },
      p.userId,
      CUSTOMER_TTL_S,
    );
    return { accessToken, expiresIn: CUSTOMER_TTL_S };
  }

  async issueAgent(p: { clientId: string; scopes: AgentScope[]; quotaPerMinute: number }): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.sign({ typ: 'agent', scope: p.scopes.join(' '), qpm: p.quotaPerMinute }, p.clientId, AGENT_TTL_S);
    return { accessToken, expiresIn: AGENT_TTL_S };
  }

  async verify(token: string): Promise<Principal> {
    let payload: Claims;
    try {
      ({ payload } = await jwtVerify<Claims>(token, this.keys.jwtPublicKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['EdDSA'],
        currentDate: this.clock.now(),
      }));
    } catch {
      throw new AppError('unauthorized', 'Invalid or expired token');
    }
    return toPrincipal(payload);
  }
}

export function toPrincipal(payload: Claims): Principal {
  const sub = payload.sub;
  if (!sub) throw new AppError('unauthorized', 'Token has no subject');
  if (payload.typ === 'agent') {
    return {
      kind: 'agent',
      subject: `agent:${sub}`,
      clientId: sub,
      scopes: parseScopes(payload.scope),
      quotaPerMinute: payload.qpm && payload.qpm > 0 ? payload.qpm : 60,
    };
  }
  if (payload.typ === 'customer' && payload.ctk) {
    return {
      kind: 'customer',
      subject: `customer:${payload.ctk}`,
      userId: sub,
      customerToken: payload.ctk,
      role: payload.role === 'admin' ? 'admin' : 'customer',
      mfa: Array.isArray(payload.amr) && payload.amr.includes('otp'),
      scopes: new Set(ALL),
    };
  }
  throw new AppError('unauthorized', 'Unsupported token type');
}

/**
 * Keycloak / any OIDC issuer (growth). Users map to customers by `sub`; realm role "admin" maps to
 * admin; service accounts (client credentials) map to agents via `azp` and the `scope` claim.
 */
export class OidcTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwks?: Parameters<typeof createLocalJWKSet>[0],
  ) {
    this.jwks = jwks
      ? createLocalJWKSet(jwks)
      : createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`));
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload & { realm_access?: { roles?: string[] }; scope?: string; azp?: string; client_id?: string; amr?: string[]; acr?: string };
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience }));
    } catch {
      throw new AppError('unauthorized', 'Invalid or expired token');
    }
    const roles = payload.realm_access?.roles ?? [];
    const clientId = payload.client_id ?? (roles.includes('agent') ? payload.azp : undefined);
    if (clientId) {
      return { kind: 'agent', subject: `agent:${clientId}`, clientId, scopes: parseScopes(payload.scope), quotaPerMinute: 60 };
    }
    if (!payload.sub) throw new AppError('unauthorized', 'Token has no subject');
    return {
      kind: 'customer',
      subject: `customer:oidc_${payload.sub}`,
      userId: payload.sub,
      customerToken: `oidc_${payload.sub}`,
      role: roles.includes('admin') ? 'admin' : 'customer',
      mfa: (payload.amr ?? []).some((m) => m === 'otp' || m === 'mfa') || payload.acr === 'mfa',
      scopes: new Set(ALL),
    };
  }
}
