import { Inject, Injectable } from '@nestjs/common';
import type { Executor } from '../../../shared/db/database.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { pendingEvents } from '../../../shared/outbox/outbox.js';
import { OrderEmails } from '../../notifications/index.js';
import { PaymentsService } from '../../payments/index.js';
import { CheckoutCompletion } from './checkout-completion.js';
import type { CheckoutActivities } from './checkout-saga.js';
import { OrderLifecycle } from './order-lifecycle.service.js';

/** The checkout saga's activities, bound to the services that implement them. The workflow worker runs these. */
@Injectable()
export class CheckoutSagaSteps {
  /** A plain object: Temporal registers an object's own functions as activities. */
  readonly activities: CheckoutActivities;

  constructor(
    @Inject(DB) db: Executor,
    @Inject(CheckoutCompletion) completion: CheckoutCompletion,
    @Inject(OrderLifecycle) lifecycle: OrderLifecycle,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(OrderEmails) emails: OrderEmails,
  ) {
    this.activities = {
      reserveStock: (sessionId) => completion.holdSession(sessionId),
      createOrder: (input) => completion.placeBySaga(input),
      createPayment: (orderId) => lifecycle.openPayment(orderId),
      paymentState: (orderId) => lifecycle.paymentState(orderId),
      commitStock: (orderId) => lifecycle.commitStock(orderId),
      issueInvoice: (orderId) => lifecycle.issueInvoice(orderId),
      // Once, whichever gets there first: an event the relay already published was emailed by the consumer itself.
      notify: async (orderId) => {
        for (const e of await pendingEvents(db, 'order.paid', orderId)) await emails.deliver(e);
      },
      abandon: (sessionId, reason) => lifecycle.abandon(sessionId, reason),
      refund: async (orderId, reason) => void (await payments.refund(orderId, reason)),
    };
  }
}
