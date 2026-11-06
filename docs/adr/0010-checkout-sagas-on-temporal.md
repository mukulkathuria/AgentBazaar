# ADR 0010: Run checkout and payment as a Temporal saga in scale, behind a workflow engine port

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mukul Kathuria

## Context

Milestone S4 asks for Temporal workflows for checkout and payment, with this definition of done: a crash injected at every step resumes to a correct final state.

Until now checkout and payment ran in the API process. Completing a checkout placed the order, moved the stock hold onto it and opened the gateway payment. A signed webhook then recorded the payment, and outbox consumers committed the stock, issued the GST invoice, marked the order paid and sent the email ([ADR 0003](0003-outbox-and-event-bus.md)). Each of those steps is a transaction and every consumer is idempotent, so lite is already crash-safe for a single step. What it lacks is a durable owner for the whole flow: the payment deadline, the compensations, and a refund that must not be lost (`refundAfterCommit` admits it has no automatic retry). At scale those belong to a workflow engine that survives the process.

Lite must not change, and must not need any extra service.

## Decision

- A `WorkflowEngine` port in the orders module, chosen by `WORKFLOW_ENGINE`:
  - **`inprocess` (default)** binds no engine. Checkout completes in the API's own transaction and payments settle in the outbox consumer, exactly as before.
  - **`temporal`** runs `checkoutSaga` on a Temporal worker. The API imports `@temporalio/client` only in this mode (dynamic import). Only the worker process (`node dist/cli/index.js workflow-worker`) loads `@temporalio/worker`.
- The saga runs reserve stock → create order → create payment → wait for the payment → commit stock (the order becomes paid) → issue invoice → notify.
- **Waiting for the payment.** The webhook handler records the payment as before. Its `payment.status_changed` outbox event wakes the saga with a signal. The signal carries no data: the saga re-reads the order and payment from the database, so replayed, late and out-of-order webhooks cannot mislead it. Going through the outbox avoids a dual write (webhook commit, then signal). The deadline is the order's `payment_expires_at`, so a UPI payment that is seen but not yet settled extends it.
- **Compensations.**
  - On timeout or cancellation: close the unpaid order (`expired`, or `cancelled` for a cancel and for unreconciled UPI) and release its stock and the session's.
  - When money reached an order that is closed or sold out: refund it once.
  - Once the money is in, the saga finishes even if a cancel arrives. Cancelling a paid order stays the normal order-cancel flow, which refunds.
- **Idempotent activities.** Temporal retries and replays steps, so each step is safe to run twice:
  - creating the order returns the order already placed for the session;
  - the payment row is created once per order (advisory lock), and the gateway is called again only if that call never completed;
  - committing stock checks the order's status in the same transaction that commits;
  - one invoice per order;
  - the email is claimed in `processed_events` under the email consumer's own name, so the saga and the outbox relay send it once between them;
  - refunds are claimed by the unique `refunds_one_per_payment` index.

  Business refusals (`AppError`, such as `out_of_stock`) fail the step at once, without retries, typed with the API's error code. The API answers the buyer with the same 409 as in lite.
- **No personal data in workflow history.** The API puts the buyer's details in the PII vault before starting the saga. The workflow input carries vault tokens and the SHA-256 of the order's one-time access token; the token itself stays in the API's response. Workflow IDs are `checkout-<sessionId>`: a double submit is refused, and a failed run may be retried.
- The API waits for the order with Update-with-Start (`placed` update), so the buyer still gets the order and its payment link in the same response.
- Unlike the outbox relay and the event bus, there is no in-process emulation of Temporal.

## Consequences

- A worker can die at any point, including after a step's database commit but before Temporal records the step as done, and the saga still finishes with one paid order, one stock commit, one invoice and one email. Failure paths compensate once. `apps/api/test/services/sagas.spec.ts` proves this against a real Temporal server and Postgres by SIGKILLing a worker process at every step. Results are in [docs/architecture/sagas.md](../architecture/sagas.md).
- Scale gains a hard dependency on Temporal (Temporal Cloud, or the Temporal Helm chart on a durable database) and a second deployment, the worker.
- The worker needs glibc: Temporal's native core ships no musl build. The API image stays on Alpine, and the worker image is the Dockerfile's `workflow-worker` target on Debian slim.
- A crashed worker's in-flight step is retried only after its 15 s start-to-close timeout. That is the recovery time per crash.
- Workflow code changes must stay replay-compatible (`patched()` or a new workflow type) once sagas are in flight.
- The saga's paid transition comes before the invoice step, so for a moment a paid order may show no invoice number. In-process settlement still does both in one transaction.

## Alternatives considered

- **Keep everything in-process and add a refund sweep:** smaller, but leaves the deadline, compensations and retries spread across jobs, which the S4 milestone exists to replace.
- **Signal straight from the webhook handler:** one hop fewer, but a crash between the webhook commit and the signal would lose the wake-up. The outbox already delivers at least once.
- **Pass the buyer's details through the workflow:** simpler, but writes personal data into Temporal's history, which the PII vault exists to prevent.
- **Bundle the workflow at build time:** faster worker start. It is left for later; the worker bundles at startup, and the tests bundle once and reuse it.
