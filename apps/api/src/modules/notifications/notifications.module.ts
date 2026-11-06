import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import type { Executor } from '../../shared/db/database.js';
import { CONFIG, DB, EVENT_BUS, LOGGER } from '../../shared/kernel/tokens.js';
import { runIdempotent, type EventBus, type OutboxEvent, type Subscription } from '../../shared/outbox/outbox.js';
import { ORDER_EMAIL_TOPICS, orderEmailFor, type MailerPort } from './domain/mailer.js';
import { LogMailer } from './infrastructure/log-mailer.js';

export const MAILER = Symbol('MAILER');

/** Order emails from outbox events. The checkout saga delivers through the same consumer, so each goes out once. */
@Injectable()
export class OrderEmails {
  readonly subscription: Subscription = {
    consumer: 'notifications-orders',
    topics: ORDER_EMAIL_TOPICS,
    handler: async (event) => {
      const mail = orderEmailFor(event.topic, event.payload);
      if (mail) await this.mailer.send(mail);
    },
  };

  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  /** Sends the email for an event unless the outbox relay already did (or does it concurrently). */
  deliver(event: OutboxEvent): Promise<boolean> {
    return runIdempotent(this.db, this.subscription.consumer, event, this.subscription.handler);
  }
}

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
    OrderEmails,
  ],
  exports: [MAILER, OrderEmails],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(OrderEmails) private readonly emails: OrderEmails,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.emails.subscription);
  }
}
