import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import { CONFIG, EVENT_BUS, LOGGER } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { ORDER_EMAIL_TOPICS, orderEmailFor, type MailerPort } from './domain/mailer.js';
import { LogMailer } from './infrastructure/log-mailer.js';

export const MAILER = Symbol('MAILER');

@Module({
  providers: [
    {
      provide: MAILER,
      inject: [CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger): MailerPort => {
        // Fail at boot rather than silently dropping customer emails.
        if (config.env.MAILER !== 'log')
          throw new Error(`MAILER=${config.env.MAILER} has no adapter yet; use MAILER=log`);
        return new LogMailer(logger);
      },
    },
  ],
  exports: [MAILER],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe({
      consumer: 'notifications-orders',
      topics: ORDER_EMAIL_TOPICS,
      handler: async (event) => {
        const mail = orderEmailFor(event.topic, event.payload);
        if (mail) await this.mailer.send(mail);
      },
    });
  }
}
