import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  allHandlersFinished,
  condition,
  defineSignal,
  defineUpdate,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  type ActivityOptions,
} from '@temporalio/workflow';
import {
  SAGA,
  type CheckoutActivities,
  type CheckoutSagaInput,
  type PlacedCheckout,
} from '../../application/checkout-saga.js';

/*
 * The checkout and payment saga. Workflow code must be deterministic: it only calls activities,
 * timers and Temporal's own APIs (Date.now() here is the workflow's replay-safe clock).
 */

const wakeSignal = defineSignal(SAGA.wake);
const placedUpdate = defineUpdate<PlacedCheckout>(SAGA.placed);

const options = {
  // Steps take milliseconds (a gateway call has its own 8 s timeout); a worker that dies mid-step is
  // detected after this long and the step runs again on another worker.
  startToCloseTimeout: '15s',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s' },
  // A cancel waits for the running step to finish, so compensation never races it.
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
} satisfies ActivityOptions;
const steps = proxyActivities<CheckoutActivities>(options);
// Like in-process checkout, opening the payment gives up after a few tries; the order then waits, without a link, until it expires.
const payment = proxyActivities<CheckoutActivities>({
  ...options,
  retry: { ...options.retry, maximumAttempts: 4 },
});

export type SagaOutcome = 'cod_confirmed' | 'paid' | 'refunded' | 'expired' | 'closed';

/** reserve stock -> create order -> create payment -> wait for the money -> commit stock -> issue invoice -> notify. */
export async function checkoutSaga(input: CheckoutSagaInput): Promise<SagaOutcome> {
  let placed: PlacedCheckout | undefined;
  let refused: ApplicationFailure | undefined;
  let woken = false;
  setHandler(wakeSignal, () => {
    woken = true;
  });
  // The API waits on this update to answer the buyer with their new order (or the reason there is none).
  setHandler(placedUpdate, async () => {
    await condition(() => placed !== undefined || refused !== undefined);
    if (refused) throw refused;
    return placed!;
  });

  try {
    await steps.reserveStock(input.sessionId);
    const order = await steps.createOrder(input);
    if (order.method === 'online') await openPayment(order.orderId);
    placed = order;
    if (order.method === 'cod') return 'cod_confirmed';

    // Wait for the money. The database is the source of truth; a signal only says "look again", so
    // replayed, late or out-of-order webhooks cannot mislead the saga.
    for (;;) {
      woken = false;
      const s = await steps.paymentState(order.orderId);
      if (s.state === 'settled') break;
      if (s.state === 'closed') return await compensate(input.sessionId, 'cancelled', 'closed');
      const left = s.expiresAt - Date.now();
      if (left <= 0) return await compensate(input.sessionId, 'expired', 'expired');
      await condition(() => woken, left);
    }
  } catch (err) {
    if (!placed)
      refused = isCancellation(err)
        ? ApplicationFailure.nonRetryable('This checkout was cancelled', 'conflict')
        : refusal(err);
    await CancellationScope.nonCancellable(async () => {
      if (isCancellation(err)) await compensate(input.sessionId, 'cancelled', 'closed');
      await condition(allHandlersFinished);
    });
    throw err;
  }
  // The money is in: the saga now finishes even if someone asks to cancel it.
  return CancellationScope.nonCancellable(() => settle(placed.orderId));
}

async function openPayment(orderId: string): Promise<void> {
  try {
    await payment.createPayment(orderId);
  } catch (err) {
    if (isCancellation(err)) throw err;
    log.warn('payment creation failed; the order is kept without a payment link', { orderId });
  }
}

/** Commit the stock (the order is paid), invoice it and tell the buyer. Money for a closed or sold-out order goes back. */
async function settle(orderId: string): Promise<SagaOutcome> {
  const committed = await steps.commitStock(orderId);
  if (committed !== 'committed') {
    await steps.refund(
      orderId,
      committed === 'sold_out' ? 'out_of_stock_after_payment' : 'payment_after_close',
    );
    return 'refunded';
  }
  await steps.issueInvoice(orderId);
  await steps.notify(orderId);
  return 'paid';
}

/** Close the unpaid order and release its stock; money that already arrived goes back. Each step is idempotent. */
async function compensate(
  sessionId: string,
  reason: 'expired' | 'cancelled',
  outcome: SagaOutcome,
): Promise<SagaOutcome> {
  const closedOrder = await steps.abandon(sessionId, reason);
  if (closedOrder) await steps.refund(closedOrder, 'payment_after_close');
  return outcome;
}

/** Activities raise a refused checkout as a non-retryable failure typed with the API's error code. */
function refusal(err: unknown): ApplicationFailure {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  return cause instanceof ApplicationFailure
    ? cause
    : ApplicationFailure.nonRetryable('Checkout could not be completed', 'unavailable');
}
