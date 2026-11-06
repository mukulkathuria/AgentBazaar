# Data map

> Not legal advice. This map describes the code as of v0.9.0. Re-check it whenever a migration adds a column that
> can hold free text or an identifier.

## Design rules the code follows

- **Collect the minimum.** Accounts need an email, password and name; checkout needs an email, a delivery address
  and a phone number. There are no file uploads: customization is text plus catalog designs only.
- **One place for personal data.** Directly identifying data lives only in the `pii` schema
  ([0012_pii.sql](../../apps/api/migrations/0012_pii.sql)). Every other module holds opaque tokens
  (`cus_...` for a customer, `adr_...` for an address).
- **Encrypted per field, per customer.** Each customer gets a random 256-bit data key (DEK). Fields are encrypted
  with AES-256-GCM, and the associated data binds each ciphertext to `token:field`, so a value cannot be moved to
  another customer or column. The DEK is stored wrapped by the master key (lite: `PII_MASTER_KEY` via
  `LocalKeyWrapper`; growth/scale: an OpenBao Transit key via `OpenBaoKeyWrapper`).
- **Lookups without plaintext.** Email and phone lookups use HMAC-SHA-256 blind indexes keyed by
  `PII_BLIND_INDEX_KEY`. Phone numbers are normalised to their last 10 digits first.
- **Redaction before storage.** Free text that is logged, traced or stored as a transcript passes through
  `redact()` ([redact.ts](../../apps/api/src/shared/observability/redact.ts)), which removes EMAIL, CARD
  (Luhn-checked), AADHAAR, PHONE, PAN, UPI IDs and PIN codes that follow a "pin"/"pin code"/"postal code" keyword.
  It is regex-based: **names and street addresses typed into free text are not detected.**

## Personal data in the `pii` schema

| Data | Table and column | Protection | Notes |
| --- | --- | --- | --- |
| Email | `pii.customers.email_enc`, `email_bidx` | AES-256-GCM with the customer's DEK; HMAC blind index | Unique blind index used for sign-in and guest matching |
| Name | `pii.customers.name_enc` | AES-256-GCM | |
| Phone | `pii.customers.phone_enc`, `phone_bidx` | AES-256-GCM; HMAC blind index | Indian mobile format enforced at input |
| Delivery addresses (name, phone, line 1-2, city, state, PIN) | `pii.addresses.data_enc` | AES-256-GCM, bound to customer and address token | `state_code` is kept in plaintext because GST place of supply needs it |
| Wrapped data key | `pii.customers.wrapped_dek`, `key_id` | Wrapped by the master key or OpenBao | Set to NULL on erasure (crypto-shredding) |
| Activity time | `pii.customers.last_activity_at` | Plaintext | Drives the guest retention job |
| Consents | `pii.consents` | Plaintext, keyed by customer token | See [consent register](consent-register.md) |
| Erasure log | `pii.erasure_requests` | Plaintext, keyed by customer token | Proof that an erasure ran |

## Data outside the `pii` schema that relates to a person

| Data | Where | Protection | Notes |
| --- | --- | --- | --- |
| Account credentials | `users`: `email_bidx`, `password_hash`, `mfa_secret_enc`, role, lockout counters | scrypt password hashes; email held only as a blind index | `status` can be `erased` |
| Refresh tokens | `refresh_tokens.token_hash` | SHA-256 hashes | |
| Orders | `orders`: `customer_token`, `address_token`, `place_of_supply`, totals, tracking number | Tokens only | Guest order links use a random token stored as a hash |
| Order timeline | `order_events` (actor, note) | Append-only (database trigger) | Actor is a subject string, see below |
| Customization text | `order_line_customizations.values`, `cart_lines.customization`, `quotes.customization`, `negotiation_sessions.customization`, `checkout_sessions.lines` | **Plaintext** | Personalised text can contain names, for example "Happy birthday Priya" |
| Flagged customization text | `customization_reviews.text` | **Plaintext** | Held for human moderation |
| Negotiation messages | `offers.message` | Redacted, max 500 characters, append-only | Buyer free text sent with an offer |
| Chat transcripts | `chat_messages.text_redacted`, `chat_sessions.state` | Redacted | Compact structured state instead of full history |
| LLM traces | `llm_traces.input_redacted`, `output_redacted` | Redacted, max 4,000 characters, append-only | Written only when a model or the router runs |
| Return notes | `return_requests.note` | Redacted | Reason is an enum |
| Audit trail | `audit_log.actor`, `data` | `data` redacted recursively, append-only | |
| Search queries | `analytics_events` (kind `search`, `zero_result_search`) | Redacted, cut to 100 characters | A shopper may type a name into search |
| Payment references | `payments.utr`, provider order and payment ids | Plaintext | UTR is a bank reference that a bank can link to an account |
| Webhook log | `webhook_events.payload` | Stores only kind, provider order id and amount | The raw gateway body is not stored |

### Subjects and pseudonymous identifiers

Most tables record who acted as a **subject** string: `customer:<cus token>`, `agent:<client id>`, or for callers
with no token `anon:<first 16 hex characters of SHA-256 of the IP address>`. The anonymous form is pseudonymous,
not anonymous: the hash is unsalted and the IPv4 address space is small enough to brute-force. It appears in
`negotiation_sessions`, `quotes`, `carts`, `checkout_sessions`, `chat_sessions` and `orders`. Treat it as personal
data.

## Data that leaves the system

| Recipient | When | What is sent | Configuration |
| --- | --- | --- | --- |
| Payment gateway (Razorpay) | Online payment | Amount, currency, receipt (order number), internal payment id. The buyer enters card or UPI details on the gateway's hosted page; **card data never reaches AgentBazaar** | `PAYMENT_ADAPTER=razorpay` |
| YouPI-PG (experimental, self-hosted by the operator) | UPI payment | Amount, currency, internal payment id; it returns a payment link and UPI URI | `PAYMENT_ADAPTER=youpi-pg` |
| LLM provider | Only if a model adapter is enabled | The buyer's message after redaction, buyer-visible facts, the list of allowed numbers and the template reply. **Never floors, costs or margins** | `LLM_ADAPTER=anthropic` or `openai-compatible`; default `template` sends nothing |
| AI service (`services/ai`, self-hosted) | Only if enabled | Text to classify, embed or redact | `CLASSIFIER_ADAPTER` / `EMBEDDINGS_ADAPTER=ai-service` |
| Email provider | Only if SMTP is enabled | Recipient address and message content | `MAILER=smtp`; default `log` |
| Identity provider (Keycloak or other OIDC) | Growth profile, if enabled | Account identities live in the provider's own database | `IDENTITY_PROVIDER=oidc` |
| Event brokers (NATS, Kafka) | Growth and scale | Outbox events; payloads carry ids and tokens (for example `pii.customer_erased` carries the customer token) | `EVENT_BUS` |
| Search engines (Meilisearch, OpenSearch, Qdrant) | Growth and scale | Product documents only | `SEARCH_ADAPTER` |
| Couriers | Operator process | Name, phone, address for delivery | Not integrated in code; the operator shares labels |

Prometheus metrics use route patterns, not raw URLs, because URLs can carry checkout and order tokens.

## Not collected or not stored

- Card numbers, CVV and UPI PINs (gateway-hosted fields).
- Aadhaar, PAN and similar identifiers are never requested; if typed into free text they are redacted.
- Uploaded files of any kind.
- Plaintext passwords (scrypt hashes only).

## Access

- Admin endpoints require the `admin` role and a session verified with MFA (TOTP).
- Admin views (approvals, negotiations, dashboards) return prices, SKUs and tokens, not decrypted personal data.
- Only `PiiService` decrypts personal data. The plan's separate database role for the `pii` schema is **planned**:
  today the application connects with a single database role.

## Known gaps

| Gap | Effect | Status |
| --- | --- | --- |
| Customization text is plaintext and outside the retention job | Names in personalised items persist with orders | Operator decision; see [retention schedule](retention-schedule.md) |
| Regex redaction misses names and addresses in free text | Chat, offers and search may hold them | Optional Presidio NER in `services/ai`; not wired into the API path |
| Unsalted IP hash in `anon:` subjects | Re-identifiable with effort | Open question for the next migration |
| Erasure does not reach existing backups | Erased data survives in backups until they expire | Documented in [backup-restore.md](../runbooks/backup-restore.md) |
| Single database role | No database-level separation of the `pii` schema | Planned |
