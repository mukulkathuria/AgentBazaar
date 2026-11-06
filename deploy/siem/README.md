# Wazuh SIEM for AgentBazaar (scale)

AgentBazaar ships **configuration only** for [Wazuh](https://wazuh.com): custom decoders and rules for the API's
JSON logs, a log-shipping example and a test that runs them through `wazuh-logtest`. Wazuh itself is GPL-2.0, so it
runs as a separate service you deploy (the [official Docker or Kubernetes deployment](https://documentation.wazuh.com/current/deployment-options/index.html));
nothing in this repository links to it.

```
deploy/siem/
  wazuh/decoders/agentbazaar_decoders.xml   -> /var/ossec/etc/decoders/
  wazuh/rules/agentbazaar_rules.xml         -> /var/ossec/etc/rules/
  samples/agentbazaar-api.jsonl             real log lines from apps/api/test/e2e/siem-events.e2e.spec.ts
  test/logtest.sh                           wazuh-logtest in a pinned wazuh-manager (4.14.8) container
  compose.shipping.yml, fluent-bit/         ship the API's logs to the manager over syslog (Compose)
```

## What the API logs

Every security event is one pino JSON line with a `sec` field, written where the event happens. Lines never carry
the text a buyer typed, emails or tokens; `srcip` is the client address (Fastify `req.ip`, so behind Caddy or the
ALB it is the forwarded client address) and `subject` is the pseudonymous caller (`customer:<token>`,
`agent:<client id>`, `anon:<hash>`), both kept for security monitoring only.

| `sec` | Written by | Fields |
| --- | --- | --- |
| `http.refused` | `logRefusal` in `apps/api/src/shared/http/error.filter.ts`, for every 401, 403 and 429 | `status`, `code`, `reason`, `method`, `route`, `srcip`, `subject`, `reqId` |
| `agent.injection` | `ChatService.turn` (chat and A2A) when the classifier flags prompt injection | `sessionId`, `channel`, `injections` (count in the session) |
| `audit.<action>` | `AuditService.record`, beside the `audit_log` row: erasure (`audit.identity.erased`), refresh-token reuse, admin and agent-client creation, policy changes, and `audit.pricing.lowball_offer` for an offer under 60% of the lowest price the policy allows | `actor`, `target` |

## Rules

| Rule | Level | Fires on |
| --- | --- | --- |
| 100200, 100201 | 0 | Any API line, shipped over syslog (`agentbazaar-api` decoder) or read from a JSON file (built-in `json` decoder) |
| 100210 | 5 | Failed sign-in (`/api/v1/auth/login`, `/oauth/token`) |
| 100211 | 10 | Sign-in brute force: 5 failures from one address within 2 minutes |
| 100212 | 4 | Missing, expired or invalid bearer token |
| 100213 | 10 | 10 invalid tokens from one address within a minute (token guessing or replay) |
| 100215 | 8 | Payment webhook with a bad signature |
| 100216 | 12 | 3 forged webhooks from one address within 10 minutes |
| 100220 | 10 | Admin route refused to a session without MFA |
| 100221 | 5 | Missing scope or role |
| 100230 | 6 | An agent over its per-minute quota |
| 100231 | 5 | Per-IP rate limit or session budget reached |
| 100232 | 10 | One agent over its quota 20 times within 2 minutes (runaway or abusive client) |
| 100240 | 6 | Prompt injection flagged |
| 100241 | 10 | Repeated injection in one session (the router hands it to a human) |
| 100245 | 4 | A lowball offer |
| 100246 | 10 | Floor probing: 5 lowball offers from one caller within 10 minutes |
| 100250 | 5 | Personal data erased on request (DPDP erasure) |
| 100251 | 10 | 10 erasures within 10 minutes |
| 100252 | 12 | A refresh token used twice: the session was revoked (stolen token?) |
| 100253 | 6 | Privileged change: admin or agent client created, MFA enabled, pricing policy updated |
| 100254 | 3 | Any other audit event |

The API records facts; the patterns (brute force, floor probing, runaway agents) are frequency rules here, so their
thresholds change in the SIEM without a release. Blocking happens elsewhere: CrowdSec at the lite edge, AWS WAF
rate rules at scale, and the API's own lockout and quotas.

## Install

On the Wazuh manager:

```bash
cp wazuh/decoders/agentbazaar_decoders.xml /var/ossec/etc/decoders/
cp wazuh/rules/agentbazaar_rules.xml /var/ossec/etc/rules/
chown root:wazuh /var/ossec/etc/decoders/agentbazaar_decoders.xml /var/ossec/etc/rules/agentbazaar_rules.xml
/var/ossec/bin/wazuh-control restart
```

and accept syslog from the shipper in `/var/ossec/etc/ossec.conf`:

```xml
<remote>
  <connection>syslog</connection>
  <port>514</port>
  <protocol>tcp</protocol>
  <allowed-ips>10.0.0.0/8</allowed-ips> <!-- the shipper's network -->
</remote>
```

## Ship the logs

- **Compose (lite, growth):** `compose.shipping.yml` switches the API container to Docker's `fluentd` logging driver
  and adds a Fluent Bit container that forwards each line as a syslog message from `agentbazaar-api`:
  `WAZUH_MANAGER=wazuh.internal docker compose -f deploy/compose/docker-compose.yml -f deploy/siem/compose.shipping.yml --profile lite up -d`.
- **Lines in a file:** a Wazuh agent can read them directly with `<localfile><log_format>json</log_format>...`; rule
  100201 picks them up through the built-in `json` decoder.
- **Kubernetes (scale; notes for the Helm chart):** run Fluent Bit as a DaemonSet (the `fluent/fluent-bit` chart),
  tail `/var/log/containers/*agentbazaar-api*.log` with the `cri` parser, and use the same `syslog` output as
  `fluent-bit/fluent-bit.yaml` (`syslog_message_key log`, `syslog_appname_preset agentbazaar-api`, TCP to the
  manager). Allow egress from the logging namespace to the manager on 514/TCP in the NetworkPolicy, and keep the API
  logging to stdout as it does today. A Wazuh agent DaemonSet cannot decode the CRI prefix on its own, which is why
  Fluent Bit sits in between.

## Test

`.github/workflows/siem.yml` runs on every push that touches these files or the code that writes the lines, and
nightly: it exercises the API (`siem-events.e2e.spec.ts` writes the `sec` lines to a file), then
`test/logtest.sh` feeds them to `wazuh-logtest` twice, as syslog messages and as plain JSON, and fails unless every
rule above except 100232 and 100251 (they need more events than the test makes) fires, and an ordinary API line
stays at level 0. It also parses the Compose overlay and dry-runs the Fluent Bit config. Locally, with Docker and
about 1.5 GB free: `bash deploy/siem/test/logtest.sh`.
