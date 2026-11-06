# Consent register design

> Not legal advice. Which purposes need consent, and which can rest on another lawful ground, is a question for
> counsel ([open-legal-questions.md](open-legal-questions.md), questions 1 to 4).

The consent register is the `pii.consents` table ([0012_pii.sql](../../apps/api/migrations/0012_pii.sql)),
written and read only by `PiiService`
([pii.service.ts](../../apps/api/src/modules/pii/application/pii.service.ts)).

## Record shape

| Column | Meaning |
| --- | --- |
| `id` | Increasing sequence; the latest row per purpose is the current state |
| `customer_token` | Opaque customer token (`cus_...`), never an email or name |
| `purpose` | One of `terms`, `order_fulfilment`, `marketing`, `analytics` (database CHECK constraint) |
| `granted` | `true` for a grant, `false` for a refusal or withdrawal |
| `notice_version` | Version of the privacy notice shown at the time, from `NOTICE_VERSION` (currently `2026-11-v1`) |
| `source` | Where the decision was captured, set by the caller (for example registration, account page, checkout) |
| `created_at` | Server timestamp |

Every change is a new row. Nothing updates or deletes a consent row in application code, so the table is a full
history. **No database trigger enforces this yet** (unlike `audit_log`, `offers`, `order_events` and
`llm_traces`); adding a `forbid_mutation` trigger to `pii.consents` is planned.

## Purposes

| Purpose | Used for | Captured | Default |
| --- | --- | --- | --- |
| `terms` | Accepting the terms of use and the privacy notice | Registration requires `consents.terms: true` | Required to register |
| `order_fulfilment` | Processing an order: delivery, invoicing, support | At checkout or registration (confirm in your deployment) | Needed to place an order |
| `marketing` | Promotional email or messages | Optional box at registration, account page | `false` |
| `analytics` | Analytics beyond what is strictly necessary | Account page | Not granted unless recorded |

The registration contract (`RegisterInput` in `packages/contracts/src/identity.ts`) requires `terms: true` and
defaults `marketing` to `false`. Checkout requires `acceptTerms: true` for the terms of sale; whether a consent row
is written for guest checkouts should be verified in the checkout module before launch.

## Reading the current state

`PiiService.consents()` returns the latest row per purpose
(`SELECT DISTINCT ON (purpose) ... ORDER BY purpose, id DESC`). The account view (`GET /api/v1/me`) returns each
purpose with `granted`, `noticeVersion` and the time.

## Withdrawal

- Customers change a consent with `PUT /api/v1/me/consents` and a body `{ "purpose": "...", "granted": false }`.
  Withdrawing is the same single step as granting.
- A withdrawal is a new row; the earlier grant stays in the history as evidence of what was lawful at the time.
- **Enforcement points.** Any code that sends marketing or runs optional analytics must check the latest consent
  before it acts. Marketing sends are not implemented yet (the default mailer only logs), so these checks are
  planned together with the notifications module. Add a test for each enforcement point when it lands.

## Notice versions

1. Store the published notice text with its version label (for example in your document system).
2. When the notice changes, bump `NOTICE_VERSION` in `pii.service.ts` and deploy. New rows carry the new version.
3. Decide with counsel whether the change is material. If it is, ask existing customers to confirm again; a
   re-consent prompt is **planned**, not built.
4. To find customers who consented under an old version:

   ```sql
   SELECT DISTINCT ON (customer_token, purpose) customer_token, purpose, granted, notice_version, created_at
   FROM pii.consents
   ORDER BY customer_token, purpose, id DESC;
   ```

## Erasure and consent records

`PiiService.erase()` deletes addresses and the encrypted profile but **keeps** consent rows and the erasure log.
They hold only the opaque token, so after crypto-shredding they cannot be linked back to a person by the store,
while still proving that processing had a basis and that erasure happened. Confirm with counsel that keeping them
is acceptable (question 13).

## Evidence for an audit or a complaint

For a given customer token, the register answers: what they agreed to, when, under which notice version, from
which screen, and when they withdrew. Combine it with `audit_log` (append-only) for administrative actions.

## Planned improvements

| Item | Why |
| --- | --- |
| Append-only trigger on `pii.consents` | Make the history tamper-evident at the database level |
| Re-consent flow on material notice changes | Show the new notice and record a fresh decision |
| Consent checks in notifications and analytics | Enforce withdrawals in code, with tests |
| Consent Manager integration under the DPDP framework | Only if counsel advises it (question 5) |
