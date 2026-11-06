import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import { LocalKeyWrapper, type KeyRing } from '../../shared/crypto/keyring.js';
import type { Scheduler } from '../../shared/jobs/scheduler.js';
import { CONFIG, KEYS, SCHEDULER } from '../../shared/kernel/tokens.js';
import { KEY_WRAPPER, PiiService } from './application/pii.service.js';
import { OpenBaoKeyWrapper } from './infrastructure/openbao-wrapper.js';

@Module({
  providers: [
    PiiService,
    {
      provide: KEY_WRAPPER,
      inject: [CONFIG, KEYS],
      useFactory: (config: AppConfig, keys: KeyRing) =>
        config.adapters.secrets === 'openbao'
          ? new OpenBaoKeyWrapper(config.env.OPENBAO_ADDR!, config.env.OPENBAO_TOKEN!, config.env.OPENBAO_TRANSIT_KEY)
          : new LocalKeyWrapper(keys.piiMasterKey, keys.piiKeyId),
    },
  ],
  exports: [PiiService],
})
export class PiiModule implements OnModuleInit {
  constructor(
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(PiiService) private readonly pii: PiiService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({ name: 'pii.retention', everyMs: 6 * 3600_000, run: (tx) => this.pii.retentionSweep(tx) });
  }
}
