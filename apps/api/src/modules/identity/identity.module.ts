import { Module } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { KeyRing } from '../../shared/crypto/keyring.js';
import { TOKEN_VERIFIER } from '../../shared/http/auth.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { CLOCK, CONFIG, KEYS } from '../../shared/kernel/tokens.js';
import { OrdersModule } from '../orders/index.js';
import { PiiModule } from '../pii/index.js';
import { AccountService } from './application/account.service.js';
import { AgentClientService } from './application/agent-clients.service.js';
import { OidcTokenVerifier, TokenService } from './application/token.service.js';
import { IdentityController } from './interfaces/identity.controller.js';

export const JWT_AUDIENCE = 'agentbazaar-api';

@Module({
  imports: [PiiModule, OrdersModule],
  controllers: [IdentityController],
  providers: [
    {
      provide: TokenService,
      inject: [KEYS, CONFIG, CLOCK],
      useFactory: (keys: KeyRing, config: AppConfig, clock: Clock) =>
        new TokenService(keys, config.env.PUBLIC_API_URL, JWT_AUDIENCE, clock),
    },
    {
      provide: TOKEN_VERIFIER,
      inject: [CONFIG, TokenService],
      useFactory: (config: AppConfig, builtin: TokenService) =>
        config.adapters.identity === 'oidc'
          ? new OidcTokenVerifier(config.env.OIDC_ISSUER_URL!, config.env.OIDC_AUDIENCE)
          : builtin,
    },
    AccountService,
    AgentClientService,
  ],
  exports: [TokenService, TOKEN_VERIFIER, AccountService, AgentClientService],
})
export class IdentityModule {}
