# Compliance pack

> **Not legal advice.** AgentBazaar is MIT-licensed software provided without warranty. Every operator is
> responsible for compliance in their own jurisdiction. This pack makes a review by qualified counsel faster;
> it does not replace one.

This folder is for people who run an AgentBazaar store for real customers in India (the first market), and for
the lawyer, chartered accountant and security reviewer they bring in. It describes what the code does today,
marks what is planned, and lists the questions only counsel can answer. It reflects the code as of v0.9.0
(unreleased).

| Document | What it is | Status |
| --- | --- | --- |
| [Data map](data-map.md) | Where personal data lives, how it is protected, where it can leave the system | Reflects code |
| [Consent register design](consent-register.md) | How consent is recorded, versioned and withdrawn | Reflects code; some enforcement points planned |
| [Retention schedule](retention-schedule.md) | What is deleted automatically, what is kept, what still needs a decision | Reflects code; several jobs planned |
| [DPIA template](dpia-template.md) | Fill-in data protection impact assessment, pre-filled with this product's processing | Template |
| [Incident response plan](incident-response.md) | Roles, severity, breach assessment, notification decisions | Plan; notification is a manual process |
| [Open legal questions](open-legal-questions.md) | Numbered questions for Indian counsel and your CA | For counsel |
| [Draft terms](drafts/terms.md), [privacy notice](drafts/privacy.md), [returns policy](drafts/returns.md) | Starting templates with placeholders | **DRAFT, not for publication as-is** |

Operational runbooks live in [../runbooks/](../runbooks/): [backup and restore](../runbooks/backup-restore.md),
[key rotation](../runbooks/key-rotation.md), [incidents](../runbooks/incident.md) and
[payments reconciliation](../runbooks/payments-reconciliation.md) for the experimental YouPI-PG adapter.
Security reporting is in [SECURITY.md](../../SECURITY.md) and the threat model in
[../security/threat-model.md](../security/threat-model.md).

## What the product provides for the DPDP Act 2023

| Requirement (from the project plan) | How the code supports it | Where |
| --- | --- | --- |
| Consent records with purpose, timestamp and notice version | Insert-only `pii.consents` rows: purpose, granted, `notice_version`, source, time | `apps/api/migrations/0012_pii.sql`, `NOTICE_VERSION` in `apps/api/src/modules/pii/application/pii.service.ts` |
| Purpose limitation and retention with automated deletion | `pii.retention` job erases guest customers inactive for 3 years (code default), every 6 hours | `PiiService.retentionSweep()`; other retention jobs are planned, see [retention schedule](retention-schedule.md) |
| Export on request | Decrypted profile, addresses and consent history | `PiiService.export()`; route `GET /api/v1/me/export` in `packages/contracts/src/routes.ts` |
| Erasure on request | Crypto-shredding: the customer's wrapped data key and every encrypted field are deleted | `PiiService.erase()`; route `POST /api/v1/me/erase` with `{"confirm":"ERASE"}` |
| Breach detection, runbook, notification workflow | Metrics, append-only audit trail, redacted logs; notification is a documented manual process | [incident-response.md](incident-response.md), [../runbooks/incident.md](../runbooks/incident.md) |
| Grievance contact | `GRIEVANCE_OFFICER_EMAIL` setting, for display in the storefront footer and notices | `packages/config/src/index.ts` |

The export and erase routes are defined in the API contract; their handlers ship with the identity module. Check
that both work on your deployment before you rely on them.

## What the software cannot do for you

- Decide your lawful basis, notice wording, retention periods or breach-notification duties. See
  [open-legal-questions.md](open-legal-questions.md).
- Sign agreements with payment gateways, couriers, hosting or LLM providers, or verify that they meet your
  obligations as a Data Fiduciary.
- Make the experimental YouPI-PG payment adapter acceptable to your bank. Its own README says it is not
  bank-approved, audited or production-ready.
- Replace an independent penetration test and a design review of the payment and agent flows, which the project
  plan requires before any real-money launch.

## Before taking real customers

1. Have counsel answer [open-legal-questions.md](open-legal-questions.md) and review the three drafts.
2. Fill in the [DPIA template](dpia-template.md) and keep it with your records.
3. Decide every "operator decision" row in the [retention schedule](retention-schedule.md).
4. Set up backups and run one restore drill ([../runbooks/backup-restore.md](../runbooks/backup-restore.md)).
5. Store production keys outside the database backups ([../runbooks/key-rotation.md](../runbooks/key-rotation.md)).
6. Name the people in the [incident response plan](incident-response.md) and publish the grievance contact.
7. Commission the independent security review.
