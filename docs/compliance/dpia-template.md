# Data protection impact assessment (template)

> Not legal advice. A fill-in template. Whether a DPIA is mandatory for your store depends on whether you are
> notified as a Significant Data Fiduciary ([open-legal-questions.md](open-legal-questions.md), question 6). It is
> good practice either way. Replace every `[...]`, delete rows that do not apply, and have counsel review the
> result.

## 1. Overview

| Field | Value |
| --- | --- |
| Data Fiduciary (legal name) | [STORE LEGAL NAME] |
| Contact for data protection questions | [NAME, EMAIL] |
| Grievance officer | [GRIEVANCE OFFICER], [EMAIL] (`GRIEVANCE_OFFICER_EMAIL`) |
| AgentBazaar version and profile | [e.g. v0.9.0, lite] |
| Hosting provider and region | [PROVIDER, REGION] |
| Enabled optional processors | [payment adapter, LLM adapter, SMTP, AI service, OIDC provider] |
| Assessment author / date / version | [NAME] / [DATE] / [VERSION] |
| Approved by / date | [NAME] / [DATE] |
| Next review | [DATE, or "on any change to the processing below"] |

## 2. Processing activities

Pre-filled from the code. Adjust to your configuration. The [data map](data-map.md) has field-level detail.

| # | Activity | Data | Purpose (`pii.consents` purpose) | Systems and recipients | Retention |
| --- | --- | --- | --- | --- | --- |
| P1 | Account and sign-in | Email, name, password hash, MFA secret (admins), consents | `terms` | API, Postgres `pii` schema and `users` | [see retention schedule] |
| P2 | Checkout and orders | Email, name, phone, delivery address, order lines, GST place of supply | `order_fulfilment` | API, Postgres, couriers [NAMES] | [statutory period for orders and invoices] |
| P3 | Payments | Amount, order number, provider ids, UTR | `order_fulfilment` | Razorpay or YouPI-PG [which], bank | [period] |
| P4 | **Agent channel and negotiation** (MCP, A2A, chat widget, REST) | Subject (customer token, agent client id or hashed IP), offers, redacted buyer messages, quotes, chat state | `order_fulfilment` [confirm basis with counsel] | API; LLM provider only if enabled | [period] |
| P5 | Personalised items | Customization text (may contain names), chosen catalog design | `order_fulfilment` | API, moderation queue, production/printing partner [NAME] | [period] |
| P6 | LLM phrasing (optional) | Redacted buyer text, buyer-visible facts, allowed numbers | [basis] | [LLM PROVIDER], region [REGION] | Provider terms: [link] |
| P7 | Analytics and GEO | Redacted search queries, crawler and AI-referral hits, page views | `analytics` [or other basis] | API, Postgres | [period] |
| P8 | Support handoffs | Chat session reference, reason | `order_fulfilment` | Store staff | [period] |
| P9 | Security logging and audit | Subjects, actions, redacted data, request ids | [legitimate use or legal obligation] | Logs, `audit_log`, `llm_traces` | [period] |
| P10 | Backups | Full database copy, including ciphertext and wrapped keys | [basis] | [BACKUP TARGET] | [backup window] |

## 3. Necessity and proportionality

For each activity, answer:

- Is every field needed for the purpose? (The product collects no uploads, no card data and no government ID.)
- Could the purpose be met with less identifying data? (Most modules hold tokens, not personal data.)
- Is the purpose explained in the notice, in English and Hindi? [YES/NO, link]
- How does a Data Principal export, correct, erase or withdraw consent? (Export and erase endpoints; consent
  updates on the account page.) [Confirm they work on your deployment]

## 4. Focus: agent channel and negotiation (P4)

Buyers, and AI agents acting for them, negotiate with an automated seller agent. Describe:

| Question | Answer |
| --- | --- |
| Who can negotiate? | Anonymous callers are read-only unless `DEMO_MODE=true` (demo only). Quotes need the `quote:create` scope; accepting needs `order:create` |
| What decides the price? | The pricing policy engine in code (band policy, guarded floor, concession ladder). The LLM, if enabled, only rephrases a template and a guard rejects any number the services did not produce |
| Can a person be harmed by an automated decision? | Different buyers can end with different prices. Large discounts on premium items go to a human approval queue. A human confirms address and payment before any order is placed |
| What personal data is involved? | Subject identifiers, offer amounts, redacted free-text messages |
| Is the buyer told they are dealing with an automated agent? | [Wording; see open question 27] |
| [ADD] | |

## 5. Risks

Rate likelihood and severity as Low / Medium / High. Pre-filled risks are drawn from the
[threat model](../security/threat-model.md).

| # | Risk | Likelihood | Severity | Existing controls (code) | Further action | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Database or backup copy stolen | [ ] | [ ] | Field-level AES-256-GCM with per-customer keys; keys kept outside the database | [encrypt backups, separate key storage] | [ ] |
| R2 | Master key and database stolen together | [ ] | High | Keys in environment or OpenBao, not in the database | [key storage, access review] | [ ] |
| R3 | Prompt injection leaks floors, costs or other customers' data | [ ] | [ ] | Tools return buyer-visible fields only; policy in code; output guard; router can only add caution | [adversarial testing before launch] | [ ] |
| R4 | Personal data in free text (chat, offers, search, customization) | [ ] | [ ] | Regex redaction; customization moderation queue | [Presidio NER, retention jobs] | [ ] |
| R5 | Transfer to an LLM provider outside India | [ ] | [ ] | Off by default (`LLM_ADAPTER=template`); text redacted before sending | [contract, region, counsel review] | [ ] |
| R6 | Erased data survives in backups | [ ] | [ ] | Crypto-shredding in the live database | [short backup window, notice wording, re-apply erasures after restore] | [ ] |
| R7 | Re-identification of anonymous visitors from hashed IP subjects | [ ] | [ ] | Truncated SHA-256 | [salted or keyed hash in a future migration] | [ ] |
| R8 | Payment confirmed on a bank alert that never settles (YouPI-PG) | [ ] | [ ] | Ship only on `RECONCILED`; reservation held while observed | [daily reconciliation] | [ ] |
| R9 | Over-collection or excess retention | [ ] | [ ] | Minimum fields; guest retention job | [decide every retention period] | [ ] |
| R10 | Unauthorised admin access | [ ] | [ ] | Admin role plus MFA on every admin call | [named admins, access review] | [ ] |
| [ADD] | | | | | | |

## 6. Sign-off

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| Data Fiduciary representative | [ ] | [approve / approve with actions / reject] | [ ] |
| Counsel | [ ] | [ ] | [ ] |
| Security reviewer | [ ] | [ ] | [ ] |

Actions agreed: [list with owner and due date]

## 7. Review triggers

Repeat this assessment when you enable a new processor (LLM provider, payment adapter, SMTP, OIDC), move to the
growth or scale profile, start Phase 4 ops agents, add a new data field, or after any personal data breach.
