import { Body, Controller, Get, Header, HttpCode, Inject, Post, Put } from '@nestjs/common';
import {
  ClientCredentialsInput,
  ConsentUpdate,
  CreateAgentClientInput,
  LoginInput,
  RegisterInput,
  Routes,
} from '@agentbazaar/contracts';
import type { z } from 'zod';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { AccountService, type CustomerPrincipal } from '../application/account.service.js';
import { AgentClientService } from '../application/agent-clients.service.js';

function customer(who: Principal): CustomerPrincipal {
  if (who.kind !== 'customer') throw new AppError('unauthorized', 'Sign in to continue');
  return who;
}

@Controller()
export class IdentityController {
  constructor(
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(AgentClientService) private readonly clients: AgentClientService,
  ) {}

  @Post('api/v1/auth/register')
  @Auth('public')
  @Header('cache-control', 'no-store')
  register(@Body(new ZodPipe(RegisterInput)) body: RegisterInput) {
    return this.accounts.register(body);
  }

  @Post('api/v1/auth/login')
  @HttpCode(200)
  @Auth('public')
  @Header('cache-control', 'no-store')
  login(@Body(new ZodPipe(LoginInput)) body: LoginInput) {
    return this.accounts.login(body);
  }

  @Post('api/v1/auth/refresh')
  @HttpCode(200)
  @Auth('public')
  @Header('cache-control', 'no-store')
  refresh(@Body(new ZodPipe(Routes.refresh.body)) body: { refreshToken: string }) {
    return this.accounts.refresh(body.refreshToken);
  }

  @Get('api/v1/me')
  @Auth('customer')
  me(@CurrentPrincipal() who: Principal) {
    return this.accounts.me(customer(who));
  }

  @Put('api/v1/me/consents')
  @Auth('customer')
  consent(
    @Body(new ZodPipe(ConsentUpdate)) body: z.output<typeof ConsentUpdate>,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.accounts.updateConsent(customer(who), body.purpose, body.granted);
  }

  @Get('api/v1/me/export')
  @Auth('customer')
  @Header('cache-control', 'no-store')
  exportData(@CurrentPrincipal() who: Principal) {
    return this.accounts.exportData(customer(who));
  }

  @Post('api/v1/me/erase')
  @HttpCode(200)
  @Auth('customer')
  async erase(
    @Body(new ZodPipe(Routes.eraseAccount.body)) _body: { confirm: 'ERASE' },
    @CurrentPrincipal() who: Principal,
  ) {
    await this.accounts.erase(customer(who));
    return { ok: true as const };
  }

  @Post('api/v1/me/mfa/setup')
  @HttpCode(200)
  @Auth('customer')
  @Header('cache-control', 'no-store')
  mfaSetup(@CurrentPrincipal() who: Principal) {
    return this.accounts.mfaSetup(customer(who));
  }

  @Post('api/v1/me/mfa/verify')
  @HttpCode(200)
  @Auth('customer')
  async mfaVerify(
    @Body(new ZodPipe(Routes.mfaVerify.body)) body: { code: string },
    @CurrentPrincipal() who: Principal,
  ) {
    await this.accounts.mfaVerify(customer(who), body.code);
    return { ok: true as const };
  }

  @Get('api/v1/admin/agent-clients')
  @Auth('admin')
  agentClients() {
    return this.clients.list();
  }

  @Post('api/v1/admin/agent-clients')
  @Auth('admin')
  @Header('cache-control', 'no-store')
  createAgentClient(
    @Body(new ZodPipe(CreateAgentClientInput)) body: z.output<typeof CreateAgentClientInput>,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.clients.create(body, who.subject);
  }

  /** OAuth 2.0 client credentials (RFC 6749 4.4). Accepts JSON or application/x-www-form-urlencoded. */
  @Post('oauth/token')
  @HttpCode(200)
  @Auth('public')
  @Header('cache-control', 'no-store')
  token(@Body(new ZodPipe(ClientCredentialsInput)) body: z.output<typeof ClientCredentialsInput>) {
    return this.clients.token(body);
  }
}
