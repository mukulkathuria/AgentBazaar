# Runbook: payments reconciliation (YouPI-PG, COD and gateways)

**Owner:** [PAYMENTS CONTACT] · **Daily reconciliation done by:** [NAME]

> **YouPI-PG is experimental.** Its own README describes it as a research project that is not bank-approved,
> audited or production-ready, meant for local development, demos and controlled experiments. Its suggested test
> ceiling is 20 payment attempts per day per receiving account (the project's own guideline, not an NPCI rule).
> Check your bank's terms and get legal advice before collecting customer payments with it
> ([open-legal-questions.md](../compliance/open-legal-questions.md), question 31). A licensed gateway is the
> recommended choice for real customers. Its licence terms were not confirmed when this adapter was written;
> check them before bundling or redistributing anything from it.

## How YouPI-PG works with AgentBazaar

YouPI-PG runs as a separate, self-hosted service. AgentBazaar only talks to it over its REST API and webhooks
(`YoupiPgAdapter` in [adapters.ts](../../apps/api/src/modules/payments/infrastructure/adapters.ts)). The request and
webhook shapes in the adapter are assumptions from its documentation and **must be confirmed against its OpenAPI
file** before use.

| Step | YouPI-PG | AgentBazaar payment status | Order status (state machine) | What you do |
| --- | --- | --- | --- | --- |
| Checkout | Payment created, returns a payment page and UPI link | `created` | `pending_payment` | Nothing |
| Buyer pays; a bank alert is detected | `OBSERVED_SUCCESS` (with UTR) | `observed` | `payment_observed`, stock stays reserved | **Do not ship.** An alert is not settlement |
| You import the bank statement into YouPI-PG | `RECONCILED` (with UTR) | `reconciled` | `paid` | Ship |
| Payment fails or the slot expires | `FAILED` or `EXPIRED` | `failed` | `payment_failed` | Nothing, unless money turns up later |

Payment statuses only move forward (`nextPaymentStatus` in
[payment-port.ts](../../apps/api/src/modules/payments/domain/payment-port.ts)); replayed or out-of-order events
change nothing. A payment marked `failed` can still move to `observed` or `reconciled` if money arrives late.

**One payer at a time.** YouPI-PG serves a single payer per UPI address (FIFO queue, `maxConcurrency` 1). The lite
profile starts with a warning; growth and scale refuse to start unless `PAYMENT_ALLOW_SINGLE_SLOT=true`.

## Setup checklist

- `PAYMENT_ADAPTER=youpi-pg`, `YOUPI_BASE_URL`, `YOUPI_WEBHOOK_SECRET` (and `YOUPI_API_KEY` if your instance needs
  one) in `.env`. The API refuses to start without the first two. `DEMO_MODE` cannot be used with it.
- Webhook URL in YouPI-PG: `https://<API_DOMAIN>/api/v1/payments/webhooks/youpi-pg`.
- Both hosts keep accurate time (NTP). Deliveries whose `x-youpi-timestamp` is more than one hour from the API's
  clock are refused.
- Write down where the bank statement comes from and who imports it each day.

## Webhook checks (what the API does)

1. Verifies `x-youpi-signature`, an HMAC-SHA-256 over the raw body with `YOUPI_WEBHOOK_SECRET`.
2. Requires `x-youpi-delivery-id` and a timestamp within one hour; requires a UTR on `OBSERVED_SUCCESS` and
   `RECONCILED`. Failures are answered `401 invalid_signature`.
3. Records the delivery in `webhook_events` keyed by (provider, delivery id). A repeat is answered `duplicate`.
4. Matches the payment by its YouPI-PG id, then checks amount and currency. A mismatch is recorded as
   `amount_mismatch` and answered with HTTP 409.
5. Moves the payment forward if the transition is legal (`applied`), otherwise `stale`. Unknown payments are
   `ignored`.

Only the event kind, payment id and amount are stored from the body, not the raw payload.

## Daily reconciliation

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite"
PSQL="$COMPOSE exec -T postgres psql -U agentbazaar -d agentbazaar"
```

1. Download the statement for the receiving account and import it into YouPI-PG.
2. Wait for `RECONCILED` webhooks, then list what is still only observed:

   ```bash
   $PSQL -c "SELECT p.id, p.order_id, p.amount_paise, p.utr, p.status, p.created_at
             FROM payments p WHERE p.provider = 'youpi-pg' AND p.status IN ('created','observed')
             ORDER BY p.created_at"
   ```

3. For each `observed` payment, find its UTR on the statement. If present, investigate why YouPI-PG did not
   reconcile it. If absent, the alert did not become a credit: do not ship, contact the buyer.
4. Review webhook problems since the last run:

   ```bash
   $PSQL -c "SELECT event_id, outcome, payload, received_at FROM webhook_events
             WHERE provider = 'youpi-pg' AND outcome IN ('amount_mismatch','ignored','stale')
             AND received_at > now() - interval '1 day' ORDER BY received_at"
   ```

5. List credits on the statement that match no payment in AgentBazaar (wrong amount, paid twice, paid after
   expiry). Handle them with the cases below.
6. Ship only orders whose status is `paid`.
7. File the statement, the list of UTRs and your notes for [RETENTION PERIOD, per CA].

## Exception cases

| Case | What happened | Action |
| --- | --- | --- |
| Observed, never reconciled | Bank alert seen, money not on the statement | Keep the order unshipped and check with the bank. The hourly `orders.cancel-unreconciled` job cancels an order still in `payment_observed` after 72 hours and writes `payment.unreconciled` to the audit log; work through those entries against the bank statement and refund by UPI if the money did arrive |
| Amount mismatch (HTTP 409) | Buyer paid a different amount | Not retried automatically: the delivery is recorded, and the same delivery id is a `duplicate` next time. Refund the received amount by UPI, or collect the difference and fix the order manually. Record what you did |
| Paid after the payment expired | Money arrived for a `failed` payment | The payment can still become `reconciled`, but an order that already `expired` cannot become `paid`. Refund by UPI, or create a new order with the buyer's agreement |
| Paid twice | Two credits for one order | Refund the extra credit by UPI |
| Cancelled while `payment_observed` | Buyer cancelled before reconciliation | **No automatic refund**: automatic refunds run only for paid orders. If the money arrived, refund by UPI |
| Webhooks refused (`401`) | Wrong secret or clock skew over one hour | Fix the secret or time. Redeliveries within the window are accepted; for older events, have YouPI-PG send them again or record the payment manually and note it in the incident log |
| Refund requested | Returns, cancellations | The adapter has no refund API: AgentBazaar marks the refund `pending` (payment `refund_pending`) with a `manual_...` reference. Send the money by UPI. There is no endpoint yet to mark a manual refund processed (planned); record it in your books |

Failed automatic refunds (for any adapter) are written to the audit log as `payment.refund_failed`:

```bash
$PSQL -c "SELECT at, target, data FROM audit_log WHERE action = 'payment.refund_failed' ORDER BY at DESC"
```

## Cash on delivery

COD orders start as `cod_confirmed` with a `cod_pending` payment. When an admin marks the order delivered, the
payment becomes `cod_collected`. Reconcile the courier's COD remittance against `cod_collected` payments:

```bash
$PSQL -c "SELECT order_id, amount_paise, updated_at FROM payments WHERE provider = 'cod' AND status = 'cod_collected'
          AND updated_at > now() - interval '7 days' ORDER BY updated_at"
```

COD refunds are manual (`manual_...` reference, status pending).

## Razorpay and other gateways

Razorpay confirms captures by signed webhook, so orders become `paid` without a statement import. Still reconcile
the gateway's settlement reports against `payments` with status `captured`, `refund_pending` and `refunded` on a
regular schedule. The Razorpay adapter is written from public documentation and **not yet verified against the
live sandbox**; that first run, and the switch to live keys, are human steps.
