# Checkout and payment sagas (scale, milestone S4)

In the scale profile, checkout and payment run as a durable [Temporal](https://temporal.io) saga. A crash at any step resumes to one correct outcome. Lite and growth keep running them in the API process and need no extra service. The decision and its trade-offs are in [ADR 0010](../adr/0010-checkout-sagas-on-temporal.md).

| `WORKFLOW_ENGINE`     | Who runs checkout and payment                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inprocess` (default) | The API. The order is placed in one transaction. The payment webhook's outbox event settles it (commit stock, invoice, paid) in a consumer. The Temporal SDK is never loaded.                                   |
| `temporal`            | `checkoutSaga` on a worker (`node dist/cli/index.js workflow-worker`). The API starts the saga and wakes it when a payment changes. Needs `TEMPORAL_ADDRESS`; `TEMPORAL_NAMESPACE` defaults to `default` and `TEMPORAL_TASK_QUEUE` to `agentbazaar-checkout`. |

## Steps and compensations

```
reserve stock -> create order -> create payment -> wait for the money -> commit stock -> issue invoice -> notify
       \______________ on timeout or cancel: close the order, release its stock, refund money that arrived ______________/
```

| Step                                          | What it does                                                                                                                       | Why a retry or replay changes nothing                                                                                                        | Compensation                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveStock`                                | Keeps the checkout session's stock hold, re-reserving it if the hold lapsed                                                       | Session row lock; does nothing once the session is completed                                                                                 | `abandon` releases the session's hold                                                                                                                  |
| `createOrder`                                 | Places the order with vault tokens, moves the hold onto it, closes the session                                                     | One transaction under the session lock; a completed session returns its order                                                                | `abandon`: the order becomes `expired` (timeout) or `cancelled` and its stock is released                                                               |
| `createPayment`                               | Opens the gateway payment                                                                                                          | One payment row per order (advisory lock); the gateway is called again only if that call never completed. After 4 failed tries the order waits without a payment link, as lite does after a gateway failure | None: no money has moved                                                                                                                                |
| wait                                          | Sleeps until the order's `payment_expires_at`, or until the payment webhook wakes it                                              | The signal carries no data: each wake-up re-reads order and payment, so replayed, late and out-of-order webhooks change nothing               | Timeout: `abandon` then `refund`. A cancel: the same                                                                                                   |
| `commitStock`                                 | Stock leaves the shelf and the order becomes `paid`, in one transaction                                                           | The order's status, read under its row lock                                                                                                  | Sold out, or the order was already closed: `refund`                                                                                                     |
| `issueInvoice`                                | The GST invoice and the order's invoice number                                                                                     | One invoice per order                                                                                                                        | None (a paid order keeps its invoice)                                                                                                                   |
| `notify`                                      | The "order paid" email                                                                                                             | Claimed in `processed_events` under the email consumer's own name, so the saga and the outbox relay send it once between them              | None                                                                                                                                                    |
| `refund` (compensation)                       | Refunds the captured payment of a closed order                                                                                     | `refunds_one_per_payment` unique index                                                                                                       | None                                                                                                                                                    |

Rules the saga keeps:

- **The database is the source of truth.** Payment webhooks are handled exactly as in lite: signature check, dedupe by event ID, then a forward-only status. The `payment.status_changed` outbox event then wakes the saga instead of settling the order in-process. If no saga is running for the order, for example because money arrived after the saga closed it, the in-process path handles it as before and refunds money that reached a closed order.
- **Once the money is in, the saga finishes even if it is cancelled.** Cancelling a paid order is the normal order cancel, which refunds.
- **Refusals fail fast.** A step that raises an `AppError`, such as `out_of_stock` or an expired checkout, is not retried. The API answers the buyer with the same 409 as in lite.
- **No personal data in Temporal.** The API puts the buyer's details in the PII vault first. The workflow input holds vault tokens and the SHA-256 of the order's one-time access token.
- **Determinism.** The workflow (`apps/api/src/modules/orders/infrastructure/temporal/checkout.workflow.ts`) imports only `@temporalio/workflow` and the saga's types, and uses the workflow clock and timers. Changes to it must stay replay-compatible (`patched()`) while sagas are in flight.
- **Recovery time.** A step left running by a dead worker is retried after its 15 s start-to-close timeout, on any live worker.

Known limits:

- **A crash in the middle of a refund.** `PaymentsService.refund` claims the refund row before it calls the gateway. A crash between the two leaves the refund `pending`, and a retry sees the claim and does not call the gateway again. Lite behaves the same way. Closing this gap needs a gateway idempotency key on refunds. A crash after the refund call returns, which the suite covers, is safe.
- **Only the "order paid" email is a saga step.** "Order created" still goes out through the outbox relay, as in lite.
- **Compose runs a single-node Temporal.** Run Temporal Cloud or the Temporal Helm chart where more availability is needed.

## How to run it

```bash
# Temporal for development (the same image the tests use):
docker compose -f tests/infra/docker-compose.yml up -d --wait postgres temporal

# API and worker, both with:
export WORKFLOW_ENGINE=temporal TEMPORAL_ADDRESS=localhost:7233
pnpm --filter @agentbazaar/api dev            # the API
pnpm --filter @agentbazaar/api cli workflow-worker   # the saga worker (production: node dist/cli/index.js workflow-worker)
```

- **Compose:** `--profile scale` adds a single-node `temporal` (state kept in a volume) and `workflow-worker`. Set `WORKFLOW_ENGINE=temporal` and `TEMPORAL_ADDRESS=temporal:7233` in `.env` so the API uses them.
- **Worker image:** the Dockerfile's `workflow-worker` target, on Debian slim because Temporal's native worker core ships no musl build. The API image stays on Alpine.
- **Kubernetes:** run Temporal from its Helm chart (or use Temporal Cloud) and run the worker as its own Deployment with the API's config and secrets, `WORKFLOW_ENGINE=temporal` and `TEMPORAL_ADDRESS`. Use at least two replicas and no Service.
- **Operating it:**
  - `temporal workflow list --query 'WorkflowType="checkoutSaga"'` shows sagas in flight.
  - `temporal workflow cancel --workflow-id checkout-<sessionId>` cancels one; its compensations run.
  - Stopping a worker with SIGTERM lets it finish the step it is running.

## Tests and measured results

- `apps/api/test/services/sagas.spec.ts` (`@scale`, services project, real Temporal and Postgres) runs workers as child processes and SIGKILLs one at every step, right after the step's database commit and before Temporal records the step as done. A fresh worker then takes over. Run it with `pnpm --filter @agentbazaar/api test:services -- sagas`.
- `apps/api/test/integration/checkout-saga.int.spec.ts` runs every step twice in a row on PGlite, as a retry or replay would, and checks each effect happened once.
- The lite e2e suites (`checkout`, `payments`, `orders`) are unchanged and still pass.

### Measured: GitHub Actions, 2026-11-06

Services workflow [run 42198801458](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42198801458): `ubuntu-latest`, `temporalio/temporal:1.10.0` dev server, `pgvector/pgvector:pg18`, commit `9fce948`. All 12 saga tests passed; the file took 210.8 s. Most of each crash scenario's roughly 19 s is the dead worker's step timing out (15 s) before it runs again on the new worker.

| Scenario (worker SIGKILLed right after the step's commit)                     | Final state checked                                                                                                         | Time   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `reserveStock`                                                                | paid; 1 invoice; 1 `paid` event; 1 committed reservation; 1 captured payment; 0 refunds; stock −1 once; 1 "order paid" email | 20.9 s |
| `createOrder`                                                                 | same                                                                                                                        | 19.4 s |
| `createPayment`                                                               | same                                                                                                                        | 19.0 s |
| `paymentState`                                                                | same                                                                                                                        | 19.5 s |
| `commitStock`                                                                 | same                                                                                                                        | 20.1 s |
| `issueInvoice`                                                                | same                                                                                                                        | 19.5 s |
| `notify`                                                                      | same                                                                                                                        | 19.0 s |
| killed while waiting; failed, captured, replayed and stale webhooks; a double submit | same; webhook outcomes applied, applied, duplicate, stale; double submit is 409; history replayed on a new worker            | 12.6 s |
| payment failed, then the window closes (killed after `abandon`)               | expired once; stock back to where it was; no invoice; 0 refunds                                                             | 19.6 s |
| saga cancelled (killed after `abandon`)                                       | cancelled once; stock back; no invoice; 0 refunds                                                                           | 18.5 s |
| money captured, then the saga cancelled (killed after `refund`)               | cancelled once; stock back; exactly 1 refund, payment `refunded`, even after the late capture event is relayed             | 18.6 s |
| sold out after the hold lapsed                                                | API answers 409 `out_of_stock`; no order                                                                                    | 2.4 s  |

The PGlite integration test (6 tests) and the lite e2e suites for checkout, payments and orders (23 tests) pass locally and in [CI run 42199064053](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42199064053).
