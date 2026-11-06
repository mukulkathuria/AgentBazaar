# Incident response plan

> Not legal advice. Statutory notification duties and deadlines (DPDP Act 2023 and its Rules, CERT-In
> directions, contracts with banks and gateways) must be confirmed with counsel before launch
> ([open-legal-questions.md](open-legal-questions.md), questions 3 and 10). This plan uses placeholders for every
> deadline on purpose.

This is the policy layer: who decides what, and how a personal data breach is assessed and reported. The
hands-on steps (commands, containment switches) are in [../runbooks/incident.md](../runbooks/incident.md).
Vulnerability reports from outside arrive through [SECURITY.md](../../SECURITY.md).

## Roles

Name a person and a deputy for each role before launch. In a small store one person may hold several roles, but
the incident lead and the person doing the technical work should differ when possible.

| Role | Responsibilities | Person / deputy |
| --- | --- | --- |
| Incident lead | Declares the incident and its severity, keeps the timeline, makes the final call on notifications with counsel | [NAME] / [NAME] |
| Technical lead | Investigates, contains, preserves evidence, restores service | [NAME] / [NAME] |
| Counsel / data protection contact | Decides whether and whom to notify, and the wording | [NAME] / [FIRM] |
| Communications | Customer messages, status page, replies to the grievance inbox | [NAME] |
| Payments contact | Talks to the gateway or bank, runs reconciliation | [NAME] |

Keep an up-to-date contact sheet (phone numbers that work at night) outside the systems that might be down.

## Severity

| Level | Examples | Response |
| --- | --- | --- |
| SEV1 | Confirmed or likely personal data breach; secret keys exposed; goods sold below the price floor at scale; payments marked paid without money | All roles engaged now; counsel informed at once |
| SEV2 | Store down or checkout broken; suspected but unconfirmed exposure; webhook failures delaying orders | Technical lead engaged now; incident lead informed |
| SEV3 | Degraded performance, a single failed refund, a flagged abuse pattern | Handled in working hours |

Set internal response targets for each level: [SEV1 target], [SEV2 target], [SEV3 target].

## Phases

1. **Detect.** Sources available today: health and readiness endpoints (`/healthz`, `/readyz`), Prometheus metrics
   (`/metrics`, not exposed by Caddy), redacted application logs, the append-only `audit_log` and `llm_traces`
   tables, CI security scans (gitleaks, Semgrep, OSV-Scanner, Trivy), private vulnerability reports, and the
   grievance inbox. Alerting rules and a SIEM are not shipped in lite; set up alerts on the metrics you rely on.
2. **Triage.** Assign a severity, open an incident record (template below), start the timeline.
3. **Contain.** Use the switches in the [incident runbook](../runbooks/incident.md): fixed-price mode, template-only
   replies, disabling an agent client, key rotation, taking the API offline.
4. **Preserve evidence.** Snapshot volumes and export logs before changing anything that would overwrite them.
   `audit_log`, `llm_traces`, `offers` and `order_events` are append-only in the database, which helps establish
   what happened.
5. **Eradicate and recover.** Fix the cause, restore from backup if needed
   ([backup-restore.md](../runbooks/backup-restore.md)), rotate affected keys
   ([key-rotation.md](../runbooks/key-rotation.md)).
6. **Notify.** Decide with counsel, using the assessment below.
7. **Review.** Blameless post-incident review. Every fixed bug gets a regression test, as the project's test
   strategy requires.

## Personal data breach assessment

Answer these as soon as possible and record the answers with timestamps.

| Question | Why it matters |
| --- | --- |
| Which data categories were involved? Use the [data map](data-map.md) | Profile, addresses and phone are encrypted; customization text, redacted transcripts and tokens are not |
| Was ciphertext exposed together with the key that unwraps it (`PII_MASTER_KEY` or the OpenBao Transit key)? | Ciphertext alone is unreadable; with the key it is not |
| Was `PII_BLIND_INDEX_KEY` exposed? | It allows confirming whether a known email or phone is a customer |
| How many Data Principals, and which ones? | Needed for notices; customer tokens identify affected rows |
| Was anything changed or deleted, or only read? | Integrity and availability breaches are breaches too |
| Is the exposure ongoing? | Containment comes first |
| Are payments, credentials or tokens involved? | Gateway, bank and session actions may be needed |
| Did a processor cause it (hosting, gateway, LLM provider)? | Their contract may set notice duties both ways |

Encryption reduces harm but does not by itself decide whether a breach must be reported. Counsel decides.

## Notification decisions

The breach-notification workflow is **manual**: there is no notification feature in the code. Prepare templates
in advance and keep them with this plan.

| Recipient | When (confirm with counsel) | Content (confirm with counsel) | Owner |
| --- | --- | --- | --- |
| Data Protection Board of India | [Per DPDP Rules] | [Prescribed details] | Incident lead + counsel |
| Affected Data Principals | [Per DPDP Rules] | [Nature, likely consequences, steps taken, steps they can take, contact] | Communications + counsel |
| CERT-In | [If its directions apply to the incident type] | [Prescribed form] | Technical lead + counsel |
| Payment gateway or bank | [Per contract] | [Per contract] | Payments contact |
| Hosting, LLM or other processors | [Per contract] | [Facts needed to investigate] | Technical lead |
| Law enforcement | [If a crime is suspected] | [ ] | Counsel |

## Breach and incident register

There is no register table in the database. Keep one in your document system with: incident id, dates (detected,
contained, closed), severity, summary, data and principals affected, root cause, actions, notifications sent (to
whom, when, by whom), and lessons learned. Keep it for [PERIOD, confirm with counsel].

## Incident record template

```text
Incident id:            [YYYY-MM-DD-n]
Declared by / at:       [NAME] / [TIME, IST]
Severity:               [SEV1/2/3]   Changed at: [TIME] reason: [ ]
Summary:                [one paragraph]
Timeline (IST):         [time - event - who]
Data involved:          [categories, encrypted or not, keys exposed or not]
Principals affected:    [count, how identified]
Containment actions:    [what, when, who]
Evidence preserved:     [snapshots, log exports, locations]
Notifications:          [recipient - time - channel - by whom]
Root cause:             [ ]
Follow-up actions:      [action - owner - due date]
Closed by / at:         [NAME] / [TIME]
```

## Practice

Run a tabletop exercise before launch and then [FREQUENCY]: walk through a leaked database backup, a leaked
`.env` file, and a buyer agent that extracted a discount below policy. Pair it with the quarterly restore drill.
