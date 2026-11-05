import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Infra } from './bootstrap/infra.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { AuthGuard } from './shared/http/auth.js';
import { HealthController } from './shared/http/health.controller.js';
import { InfraModule } from './shared/infra.module.js';

/** Composition root: wires infrastructure and every feature module. */
@Module({})
export class AppModule {
  static register(infra: Infra): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.register(infra), IdentityModule],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
