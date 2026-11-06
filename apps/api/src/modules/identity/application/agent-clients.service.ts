import { Inject, Injectable } from '@nestjs/common';
import type {
  AgentClientView,
  AgentScope,
  ClientCredentialsInput,
  CreateAgentClientInput,
  OAuthTokenResponse,
} from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { randomToken, safeEqual, sha256Hex } from '../../../shared/crypto/primitives.js';
import { one, rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { AuditService } from '../../audit/index.js';
import { TokenService } from './token.service.js';

interface ClientRow {
  id: string;
  client_id: string;
  secret_hash: string;
  name: string;
  scopes: AgentScope[];
  quota_per_minute: number;
  status: 'active' | 'disabled';
  created_at: Date;
}

const view = (c: ClientRow): z.infer<typeof AgentClientView> => ({
  id: c.id,
  clientId: c.client_id,
  name: c.name,
  scopes: c.scopes,
  quotaPerMinute: c.quota_per_minute,
  status: c.status,
  createdAt: c.created_at.toISOString(),
});

/** OAuth client-credentials clients for buyer agents. Secrets are shown once and stored as SHA-256. */
@Injectable()
export class AgentClientService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    input: z.output<typeof CreateAgentClientInput>,
    actor: string,
  ): Promise<z.infer<typeof AgentClientView>> {
    const secret = `abs_${randomToken(32)}`;
    const c = await one<ClientRow>(
      this.db,
      sql`INSERT INTO agent_clients (client_id, secret_hash, name, scopes, quota_per_minute)
          VALUES (${`agt_${randomToken(12)}`}, ${sha256Hex(secret)}, ${input.name}, ${pgArray([...new Set(input.scopes)], 'text')},
                  ${input.quotaPerMinute})
          RETURNING *`,
    );
    await this.audit.record(null, actor, 'identity.agent_client_created', c!.client_id, {
      name: input.name,
      scopes: c!.scopes,
    });
    return { ...view(c!), clientSecret: secret };
  }

  async list(): Promise<z.infer<typeof AgentClientView>[]> {
    return (
      await rows<ClientRow>(this.db, sql`SELECT * FROM agent_clients ORDER BY created_at DESC LIMIT 500`)
    ).map(view);
  }

  /** client_credentials grant. The requested scope must be a subset of the client's scopes. */
  async token(input: z.output<typeof ClientCredentialsInput>): Promise<z.infer<typeof OAuthTokenResponse>> {
    const c = await one<ClientRow>(
      this.db,
      sql`SELECT * FROM agent_clients WHERE client_id = ${input.client_id}`,
    );
    const secretOk = safeEqual(sha256Hex(input.client_secret), c?.secret_hash ?? sha256Hex(''));
    if (!c || !secretOk || c.status !== 'active')
      throw new AppError('unauthorized', 'Invalid client credentials');
    const requested = input.scope ? [...new Set(input.scope.split(/\s+/).filter(Boolean))] : c.scopes;
    const extra = requested.filter((s) => !(c.scopes as string[]).includes(s));
    if (extra.length)
      throw new AppError('validation_failed', `Scope not allowed for this client: ${extra.join(' ')}`);
    const scopes = requested as AgentScope[];
    const t = await this.tokens.issueAgent({
      clientId: c.client_id,
      scopes,
      quotaPerMinute: c.quota_per_minute,
    });
    return {
      access_token: t.accessToken,
      token_type: 'Bearer',
      expires_in: t.expiresIn,
      scope: scopes.join(' '),
    };
  }
}
