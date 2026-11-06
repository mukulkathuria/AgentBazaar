# Runbook: key rotation

**Owner:** [NAME] · **Last rotation:** [DATE per key]

AgentBazaar holds one active key per purpose ([keyring.ts](../../apps/api/src/shared/crypto/keyring.ts)). There is
no overlap window in which an old and a new key are both accepted, so rotating a key always has a visible effect.
This runbook says what each rotation breaks, how to do it, and where the code does not support rotation yet.

Rotate on a schedule you choose ([ROTATION POLICY]) and **immediately** when a key may have been exposed: a leaked
`.env`, a compromised host, a departed administrator, or a gitleaks finding.

## Keys and what rotation does

| Key | Used for | Effect of rotating | Supported today |
| --- | --- | --- | --- |
| `QUOTE_SIGNING_KEY` | HMAC-SHA-256 signature on quote tokens (the purpose is mixed into the MAC); also derives the mock gateway's webhook secret when `MOCK_WEBHOOK_SECRET` is unset | Every outstanding quote token is rejected; buyers and agents must request a new quote | Yes: replace and restart |
| `JWT_PRIVATE_KEY` | Ed25519 (EdDSA) signature on access tokens from the built-in issuer, 15-minute lifetime | Every access token is rejected at once: treat it as a forced sign-out for people and agents | Yes: replace and restart |
| `PII_BLIND_INDEX_KEY` | HMAC blind indexes for email and phone (`pii.customers.email_bidx`, `phone_bidx`, `users.email_bidx`) | Sign-in and customer lookup fail until every index is recomputed | **No.** Needs a re-index tool (planned) |
| `PII_MASTER_KEY` (lite) | Wraps each customer's data key with AES-256-GCM; the key id (first 12 hex characters of its SHA-256) is bound into the wrapping | Every customer's wrapped key must be re-wrapped, or all personal data becomes unreadable | **No.** Needs a re-wrap tool (planned) |
| OpenBao Transit key (growth/scale) | Same role as `PII_MASTER_KEY`, via Transit with derived keys (context = customer token) | None for reads: Transit keeps old key versions for decryption | Yes in OpenBao; a re-wrap job is planned |

Missing keys are generated at random on start outside production, with a warning that quotes, sessions and
encrypted PII will not survive a restart. With `NODE_ENV=production` (and not `DEMO_MODE`) the API refuses to start
without them.

## Generating keys

`pnpm --filter @agentbazaar/api cli keys` prints a fresh set (from `generateKeyEnv()` in `keyring.ts`) as `.env`
lines. On a machine without the repository, standard tools produce equivalent keys:

```bash
openssl rand -base64 32                        # QUOTE_SIGNING_KEY, PII_MASTER_KEY, PII_BLIND_INDEX_KEY
openssl genpkey -algorithm ed25519 | awk 'NF {printf "%s\\n", $0}'   # JWT_PRIVATE_KEY on one line
```

Symmetric keys must decode to at least 32 bytes of base64. `JWT_PRIVATE_KEY` is a PKCS#8 PEM; in `.env` write the
line breaks as `\n`, which the loader turns back into newlines.

## Procedure: `QUOTE_SIGNING_KEY`

1. Pick a quiet time. Quotes live at most as long as the band's `quoteTtlSeconds` (seeded values are 600 to 900
   seconds), so after rotation the disruption ends within one quote lifetime.
2. Put the new value in `.env` (or your secrets manager) and restart the API:
   `docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite up -d api`.
3. Expect `quote_invalid` errors from buyers holding old quotes. Negotiations themselves continue; a fresh quote
   is issued on the next request or offer.
4. If you use the mock gateway without `MOCK_WEBHOOK_SECRET`, its derived webhook secret changes too; this only
   matters in demos and tests.

Rotating this key is also the fastest way to **void every outstanding discounted quote** during a pricing
incident ([incident.md](incident.md)).

## Procedure: `JWT_PRIVATE_KEY`

1. Announce a short sign-out if you have many customers.
2. Replace the key and restart the API.
3. Access tokens signed with the old key fail with `unauthorized`. Agents must request a new token with their
   client credentials; people must refresh or sign in again. Refresh tokens are random values stored as hashes,
   not signed with this key.
4. With `IDENTITY_PROVIDER=oidc` this key is not used for verification; rotate signing keys in Keycloak or your
   OIDC provider instead. The API fetches the provider's published keys.

## Procedure: OpenBao Transit key (growth/scale)

The Transit key (`OPENBAO_TRANSIT_KEY`, default `agentbazaar-pii`) must have been created with `derived=true`.

```bash
bao write -f transit/keys/agentbazaar-pii/rotate      # new version for new wraps; old versions still decrypt
bao read transit/keys/agentbazaar-pii                 # check latest_version and min_decryption_version
```

New customers get data keys wrapped with the new version. Existing wrapped keys keep working. To retire an old
version, every stored `pii.customers.wrapped_dek` must first be rewrapped through `transit/rewrap` (with the
customer token as context); a job for this is **planned**. Only after it has run, raise
`min_decryption_version`, and remember that backups taken before the rewrap still need the old version.

## Procedure: `PII_MASTER_KEY` (lite) — planned tooling

Each customer row stores a data key wrapped with the master key, plus the master key id. The local wrapper
accepts only the current key, so swapping the value in `.env` makes every existing customer unreadable.

Until a re-wrap command exists (planned), rotate this key **only** when it may be compromised, and then:

1. Stop the API (`$COMPOSE stop api`) and take a backup ([backup-restore.md](backup-restore.md)).
2. For every row in `pii.customers` with a non-null `wrapped_dek`: unwrap with the old key, wrap with the new key,
   and update `wrapped_dek` and `key_id`, all in one transaction. The customer data keys and field ciphertext do
   not change. Erased customers (`wrapped_dek IS NULL`) are skipped. This needs a small script using
   `LocalKeyWrapper` from `keyring.ts`; review it like production code.
3. Put the new key in `.env`, start the API, and check that a known test account still shows its email.
4. Keep the old key, stored as carefully as the new one, until every backup made before the rotation has expired.
5. If the key was compromised, also treat any copy of the database as exposed and follow the
   [incident response plan](../compliance/incident-response.md).

Two-factor secrets (`users.mfa_secret_enc`) are encrypted by the identity module; confirm which key protects them
before rotating and include them in the script if needed.

## Procedure: `PII_BLIND_INDEX_KEY` — planned tooling

Blind indexes cannot be recomputed from themselves; the plaintext email and phone are needed, so this also needs
the master key.

1. Stop the API and take a backup.
2. For every customer that is not erased: decrypt email and phone, compute the new HMAC indexes, and update
   `pii.customers.email_bidx` and `phone_bidx`. Update `users.email_bidx` through the shared `customer_token`.
   Use one transaction.
3. Put the new key in `.env`, start the API, sign in with a test account.

A re-index command is **planned**. Until it exists, rotate this key only if it is compromised.

## Other secrets

| Secret | How to rotate | Watch out for |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `ALTER ROLE agentbazaar PASSWORD '...'` in Postgres, then update `.env` and restart the API | The Postgres image reads `POSTGRES_PASSWORD` only when the volume is first created; changing `.env` alone does nothing |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Generate in the Razorpay dashboard, update, restart | Switching between test and live keys is a human decision |
| `RAZORPAY_WEBHOOK_SECRET` | Change in the dashboard and in `.env` together | Deliveries signed with the old secret are refused (`invalid_signature`); the gateway retries |
| `YOUPI_WEBHOOK_SECRET`, `YOUPI_API_KEY` | Change in YouPI-PG and in `.env` together | See [payments-reconciliation.md](payments-reconciliation.md) |
| `ANTHROPIC_API_KEY`, `OPENAI_COMPAT_API_KEY` | Rotate at the provider | Until restart, replies fall back to templates if the old key is revoked |
| `OPENBAO_TOKEN` | Issue a new token in OpenBao, update, restart | Use a token scoped to the Transit key only |
| `ANALYTICS_INGEST_KEY`, `WEB_REVALIDATE_SECRET` | Update in both the API and web environments | Analytics events are refused while they differ |
| Agent client secrets | Create a new client (`POST /api/v1/admin/agent-clients`), hand over the secret, then disable the old client | There is no disable endpoint yet: `UPDATE agent_clients SET status = 'disabled' WHERE client_id = '...'`. Tokens already issued stay valid until they expire (15 minutes) unless you also rotate `JWT_PRIVATE_KEY` |

Record every rotation (date, key, reason, who) in your change log; never record the key itself.
