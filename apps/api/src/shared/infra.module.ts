import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AUTH_OPTIONS, type AuthOptions } from './http/auth.js';
import {
  CACHE,
  CLOCK,
  CONFIG,
  DATABASE,
  DB,
  EVENT_BUS,
  KEYS,
  LOGGER,
  METRICS,
  OUTBOX_RELAY,
  SCHEDULER,
} from './kernel/tokens.js';
import type { Infra } from '../bootstrap/infra.js';

/** Exposes the process-wide adapters built by bootstrap to every module. */
@Global()
@Module({})
export class InfraModule {
  static register(infra: Infra): DynamicModule {
    const authOptions: AuthOptions = { anonymousScopes: infra.anonymousScopes };
    const providers = [
      { provide: CONFIG, useValue: infra.config },
      { provide: DATABASE, useValue: infra.database },
      { provide: DB, useValue: infra.db },
      { provide: CLOCK, useValue: infra.clock },
      { provide: KEYS, useValue: infra.keys },
      { provide: LOGGER, useValue: infra.logger },
      { provide: METRICS, useValue: infra.metrics },
      { provide: CACHE, useValue: infra.cache },
      { provide: EVENT_BUS, useValue: infra.bus },
      { provide: OUTBOX_RELAY, useValue: infra.relay },
      { provide: SCHEDULER, useValue: infra.scheduler },
      { provide: AUTH_OPTIONS, useValue: authOptions },
    ];
    return { module: InfraModule, providers, exports: providers.map((p) => p.provide) };
  }
}
