import type { Logger } from 'pino';
import type { MailerPort, OrderEmail } from '../domain/mailer.js';

/** Lite default: records that an email would be sent. Never logs an address, name or email. */
export class LogMailer implements MailerPort {
  constructor(private readonly logger: Logger) {}

  async send(mail: OrderEmail): Promise<void> {
    this.logger.info(
      { template: mail.template, orderNumber: mail.orderNumber, customerToken: mail.customerToken },
      'order email',
    );
  }
}
