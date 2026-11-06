> **DRAFT — NOT LEGAL ADVICE. A template for review by qualified Indian counsel before use. Do not publish as-is.**
>
> Replace every `[PLACEHOLDER]`. Notes for the operator are in *italics* and must be removed before publishing.
> This draft describes AgentBazaar's default behaviour; re-check it against your configuration (payment adapter,
> LLM adapter, mailer, hosting). Related: [data map](../data-map.md), [consent register](../consent-register.md),
> [retention schedule](../retention-schedule.md), [open-legal-questions.md](../open-legal-questions.md) (1 to 14).

# Privacy Notice

**Notice version:** [NOTICE VERSION] · **Effective from:** [DATE]

*The notice version must match `NOTICE_VERSION` in the deployed code (currently `2026-11-v1`), because every
consent we record stores the version you saw. Bump both together.*

[STORE LEGAL NAME] ("we") is the Data Fiduciary for the personal data described here. Contact: [CONTACT PERSON],
[EMAIL], [ADDRESS].

## 1. What we collect

| Data | When | Why |
| --- | --- | --- |
| Email address, name, password | When you create an account | To create and secure your account |
| Email address, name, phone number, delivery address | When you check out | To deliver your order, contact you about it, and issue the tax invoice |
| Order details: items, prices, quantities, delivery state | When you order | To fulfil the order, handle returns and keep tax records |
| Text you add to personalised items | When you personalise an item | To make the item |
| Messages and offers in chat or negotiation, including from an AI agent acting for you | When you or your agent talk to our seller assistant | To answer you, issue quotes and keep a record of the agreed price |
| Your choices about consent | When you give or withdraw consent | To show what you agreed to and when |
| An authentication code secret | Only if you turn on two-step sign-in | To verify sign-in |
| Technical data: a shortened, hashed form of your IP address for visitors who are not signed in; searches you type | When you use the store | To keep quotes and carts tied to your session, prevent abuse, and improve search |

We do **not** collect card numbers or UPI PINs (our payment provider collects payment details on its own page),
government ID numbers, or uploaded files.

## 2. How we protect it

- Your email, name, phone number and addresses are encrypted field by field with a key unique to you. Other parts
  of our system refer to you only by a random token.
- Personal details such as email addresses, phone numbers, card or ID numbers and UPI IDs are removed from logs,
  chat records and analytics automatically. *Automatic removal does not catch every name or address typed into
  free text.*
- Administrative access needs two-step sign-in. [OTHER MEASURES, e.g. hosting security, access reviews.]

## 3. Purposes and basis

| Purpose | Basis *(confirm with counsel; open question 2)* | You can withdraw |
| --- | --- | --- |
| Account and terms (`terms`) | [Consent / other] | By erasing your account |
| Orders, delivery, invoices, returns (`order_fulfilment`) | [Consent / voluntary provision for a specified purpose] | [Effect on open orders; open question 4] |
| Marketing messages (`marketing`) | Consent, off unless you turn it on | Any time, from your account page |
| Analytics (`analytics`) | [Consent / other] | Any time, from your account page |
| Security, fraud prevention, legal obligations | [Basis] | [ ] |

## 4. Automated processing and AI

- Our seller assistant is automated. Prices, discounts and quote expiry are set by our pricing rules, not by an AI
  model. Large discounts may be reviewed by a person.
- By default, replies are written from fixed templates and **no AI provider receives your messages**.
- *If you enable an LLM provider, keep this paragraph:* We use [PROVIDER] to phrase some replies. It receives your
  message after personal details are removed, plus product facts and prices you are allowed to see. It never
  receives our costs, margins or other customers' data. [PROVIDER LOCATION, TRANSFER BASIS; open question 8.]

## 5. Who we share it with

| Recipient | What | Why |
| --- | --- | --- |
| [PAYMENT PROVIDER] | Order amount and reference; you enter payment details on their page | To take payment and refunds |
| [COURIER PARTNERS] | Name, phone, delivery address | To deliver |
| [HOSTING PROVIDER] | All data we hold, encrypted where described above | To run the store |
| [EMAIL PROVIDER, if used] | Email address and message | To send order emails |
| [LLM PROVIDER, if used] | Redacted messages, as described in section 4 | To phrase replies |
| Authorities | What the law requires | Legal obligations |

**We do not sell your personal data.**

## 6. How long we keep it

- Guest checkout details: deleted [RETENTION PERIOD] after your last activity. *The code default is 3 years;
  set your own with counsel.*
- Account details: until you erase your account [or INACTIVITY POLICY].
- Orders and tax invoices: [STATUTORY PERIOD]. They refer to you only by a random token after erasure.
- Records of your consents and of an erasure: [PERIOD], as proof. They refer to you only by a random token.
- Backups: copies may remain for up to [BACKUP RETENTION] until the backup expires; they are encrypted and are not
  used for any other purpose.
- Other records: see [RETENTION SUMMARY or link].

## 7. Your rights

You can:

- **Access and export** your data: account page, or `GET /api/v1/me/export` if you use our API.
- **Correct** your details: account page or [EMAIL].
- **Erase** your account: account page, or `POST /api/v1/me/erase` with the confirmation `ERASE`. We delete your
  encryption key and every encrypted field, which makes your stored details unreadable. We keep order and invoice
  records the law requires, linked only to a random token.
- **Withdraw consent** as easily as you gave it, from your account page.
- **Nominate** a person to exercise your rights if you die or become incapable: [PROCESS].
- **Complain** to our Grievance Officer, and then to the Data Protection Board of India.

## 8. Grievance Officer

[GRIEVANCE OFFICER], [DESIGNATION], [EMAIL], [PHONE], [ADDRESS]. [RESPONSE TIMELINE, per counsel; open
question 11.]

## 9. Children

[POLICY, per counsel; open question 7. The software has no age check by default.]

## 10. Changes to this notice

When this notice changes we update the version and date above. [HOW MATERIAL CHANGES ARE ANNOUNCED AND WHETHER WE
ASK FOR CONSENT AGAIN.]

## 11. Contact

[STORE LEGAL NAME], [ADDRESS], [EMAIL].
