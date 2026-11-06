# Retention schedule

> Not legal advice. The code ships one automated deletion job and a few expiry sweeps. Every period marked
> "operator decision" must be set with counsel and your CA, because tax, consumer and data-protection laws pull in
> different directions ([open-legal-questions.md](open-legal-questions.md), questions 12 and 13).

## Jobs that run today

The scheduler ([scheduler.ts](../../apps/api/src/shared/jobs/scheduler.ts)) runs each job under a
transaction-level advisory lock, so with several API instances only one runs a given job at a time.

| Job | Interval | What it does |
| --- | --- | --- |
| `pii.retention` | Every 6 hours | Crypto-shreds **guest** customers (no active `users` row) whose `last_activity_at` is older than the retention window. Code default: `3 * 365` days. At most 200 customers per run |
| `pricing.expire-negotiations` | Every 30 seconds | Marks expired negotiations and quotes as `expired`, declines pending approvals that expired. Rows are kept |
| `inventory.expire-reservations` | Every 30 seconds | Releases stock holds whose time ran out. Rows are kept with status `expired` |

The 3-year guest window is a code default, not legal advice. Changing it today means changing the
`retentionSweep()` default in [pii.service.ts](../../apps/api/src/modules/pii/application/pii.service.ts); a
configuration setting for it is planned.

## Schedule by record type

| Record | Store | What the code does today | Policy to set |
| --- | --- | --- | --- |
| Registered customer profile and addresses | `pii.customers`, `pii.addresses` | Kept until the customer erases the account | Operator decision: inactive-account policy, if any |
| Guest customer profile and addresses | `pii.customers`, `pii.addresses` | Erased after 3 years without activity (default) | Operator decision: confirm or shorten |
| Consent history | `pii.consents` | Kept, including after erasure (token only) | Counsel: how long to keep proof of consent |
| Erasure log | `pii.erasure_requests` | Kept | Counsel: keep as proof of erasure |
| Account credentials | `users`, `refresh_tokens` | Kept; expired and revoked refresh tokens are not purged | Planned: purge expired tokens |
| Orders, order lines, invoices | `orders`, `order_lines`, `invoices`, `invoice_counters` | Kept; never erased (tokens only, no names) | CA/counsel: statutory period for tax and accounting records |
| Order timeline | `order_events` | Kept; append-only | Same as orders |
| Customization snapshots | `order_line_customizations`, `cart_lines`, `quotes`, `negotiation_sessions`, `checkout_sessions` | Kept in plaintext; not covered by erasure | Operator decision: anonymise after delivery and the return window, or keep with the order |
| Flagged customization text | `customization_reviews` | Kept | Operator decision: delete after the decision |
| Negotiations and offers | `negotiation_sessions`, `offers`, `quotes`, `pricing_approvals` | Kept; `offers` is append-only | Operator decision; offer messages are redacted |
| Chat sessions and messages, handoffs | `chat_sessions`, `chat_messages`, `handoffs` | Kept; messages redacted | Planned job; operator decision on the window |
| LLM traces | `llm_traces` | Kept; append-only; redacted | Planned archival job |
| Audit trail | `audit_log` | Kept; append-only | Counsel: security and accountability needs |
| Analytics events | `analytics_events` | Kept; dashboards read the last 30 days | Planned job; operator decision |
| Payments, refunds | `payments`, `refunds` | Kept | CA: same as orders |
| Webhook deliveries | `webhook_events` | Kept; needed to reject replays | Planned: purge after the gateways' retry windows |
| Idempotency keys | `idempotency_keys` | Kept; indexed by `created_at` for a purge job | Planned job |
| Outbox and consumer markers | `outbox_events`, `processed_events` | Kept after publishing | Planned job |
| Carts and checkout sessions | `carts`, `cart_lines`, `checkout_sessions` | Kept; cart lines are deleted only when a cart is cleared (`CartService.clear`) | Planned job |
| Cache, rate-limit and quota counters | Valkey | Not persisted (`--save ''`, `--appendonly no` in Compose) | None |
| Application logs | Container stdout; CloudWatch on the AWS lite profile | Redacted at source; CloudWatch retention defaults to 30 days (`log_retention_days`) | Operator decision |
| Backups | Your backup target; the AWS lite profile creates a `backups` bucket | No backup job ships yet; the storage module's default lifecycle moves backups to infrequent access after 30 days and expires them after 90 | Operator decision; see [backup-restore.md](../runbooks/backup-restore.md) |

## Append-only tables and deletion

`audit_log`, `llm_traces`, `offers` and `order_events` reject `UPDATE` and `DELETE` through the
`forbid_mutation()` trigger ([0001_shared.sql](../../apps/api/migrations/0001_shared.sql)). This protects
evidence, but it also means a retention job cannot delete old rows through the application. A maintenance
procedure that archives and removes old rows with a privileged role (or time partitioning, planned for the scale
profile) is **planned**. These tables hold redacted text and tokens, which limits the exposure in the meantime.

## How erasure interacts with retention

- Erasure (`POST /api/v1/me/erase`, or the retention job) deletes the customer's addresses, clears every encrypted
  field and blind index, and deletes the wrapped data key. Without that key the ciphertext is unreadable, even if
  a copy survives elsewhere in the live database.
- Orders and invoices stay, linked only by tokens, so tax records remain complete. Whether invoices must also
  name the buyer is open question 15.
- **Backups are not erased.** A backup taken before an erasure still holds the wrapped key, and anyone with the
  master key can decrypt it. Erased data therefore persists until those backups expire. Keep the backup window as
  short as your recovery needs allow, state it in the privacy notice, and re-apply erasures after any restore
  ([backup-restore.md](../runbooks/backup-restore.md)).
- Customization text and free-text fields outside the `pii` schema are not erased (see the
  [data map](data-map.md)).

## Reviewing this schedule

Review it at every release that adds a table, and at least once a year with counsel. Record each decided period
in the "Policy to set" column of your own copy, with the date and who approved it.
