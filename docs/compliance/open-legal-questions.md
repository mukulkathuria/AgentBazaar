# Open legal questions for counsel

> Not legal advice. These are questions, not answers. They are written so that Indian counsel and a chartered
> accountant can review an AgentBazaar store quickly. Each question says what the software does today, so the
> answer can be turned into a configuration change, a wording change or a code change. Other documents refer to
> these numbers; append new questions at the end instead of renumbering.

## Data protection (DPDP Act 2023 and its Rules)

1. **Notice and consent wording.** The [draft privacy notice](drafts/privacy.md) itemises data and purposes.
   Is the content, the itemisation and the English and Hindi presentation sufficient? Which other languages
   should be offered?
2. **Lawful basis per purpose.** The code records consent for four purposes: `terms`, `order_fulfilment`,
   `marketing`, `analytics`. Should order fulfilment rest on consent, or on the legitimate use where a person
   voluntarily provides data for a specified purpose? What changes in the notice and in withdrawal handling?
3. **Rule timelines.** Which DPDP Rules provisions apply to a store like this, and from which dates (including
   breach-notification timelines and content)? The [incident response plan](incident-response.md) uses
   placeholders until you answer.
4. **Withdrawal mid-order.** If a customer withdraws consent while an order is being fulfilled or a return is
   open, what may the store still process and keep?
5. **Consent Managers.** Must or should the store accept consent through a registered Consent Manager?
6. **Significant Data Fiduciary.** What would make a store a Significant Data Fiduciary, and which extra duties
   (data protection officer, DPIA, audits) would follow? A [DPIA template](dpia-template.md) is provided either way.
7. **Children.** Registration has no age gate. Must the store verify age or obtain verifiable parental consent,
   and for which products or features (for example negotiation or marketing)?
8. **Cross-border transfer.** If an operator enables an LLM provider (`LLM_ADAPTER=anthropic` or
   `openai-compatible`), redacted buyer messages and product facts are sent to that provider, possibly outside
   India. Hosting and payment gateways may also process data abroad. What is permitted, and what must the notice
   and contracts say?
9. **Processor contracts.** What terms are needed with hosting, payment, courier, email and LLM providers acting
   as Data Processors?
10. **Breach notification.** To whom, how fast and with what content must a personal data breach be reported:
    the Data Protection Board, affected Data Principals, CERT-In (do its directions apply to this kind of
    business?), payment partners?
11. **Grievance redressal.** What contact details must be published, and what acknowledgement and resolution
    timelines apply under the DPDP Rules and the Consumer Protection (E-Commerce) Rules? The store publishes
    `GRIEVANCE_OFFICER_EMAIL`.
12. **Retention periods.** For each row of the [retention schedule](retention-schedule.md) marked "operator
    decision" or "counsel", what period is required or reasonable?
13. **Records kept after erasure.** Erasure crypto-shreds the profile but keeps orders, invoices, consent history
    and an erasure log, linked only by an opaque token. Encrypted data also survives in backups until they expire.
    Is this acceptable, and how should the notice describe it?
14. **Pseudonymous data.** Anonymous visitors are identified by a truncated, unsalted SHA-256 hash of their IP
    address; search queries and chat messages are stored after regex redaction that does not remove names. How
    should these be treated, disclosed and retained?

## Tax (GST)

15. **Invoice content and numbering.** Invoices are numbered `INV/<financial year>/<6-digit serial>` per
    financial year, for example `INV/2026-27/000001` (18 characters). Invoice rows store seller details, place of
    supply, lines and totals, but no buyer name, address or GSTIN. Does this meet the invoice rules, including any
    limit on the length of the serial number, and when must the buyer be named?
16. **E-invoicing and e-way bills.** At what turnover or consignment value do e-invoicing (IRN) and e-way bills
    apply to an operator? Neither is implemented.
17. **B2B buyers.** Checkout does not capture a buyer GSTIN, so business buyers cannot claim input tax credit.
    Is that a problem for the intended market?
18. **Place of supply and negotiated prices.** Place of supply is taken from the delivery state; CGST and SGST
    apply when it equals the seller's state, IGST otherwise. Prices, including negotiated and volume prices, are
    GST-inclusive and tax is computed on the final price. Is this treatment correct?
19. **Rates and HSN codes.** Seeded GST rates and HSN codes are illustrative. What process should operators follow
    to classify products and track rate changes (rates are stored with effective dates)?
20. **E-commerce operator status.** If an operator later lists other sellers' goods, does tax collection at source
    or other marketplace duties apply? The software is built as a single-seller store.

## Consumer protection and product rules

21. **E-Commerce Rules disclosures.** Which disclosures must appear on the storefront and product pages (seller
    details, grievance officer, return and refund terms, country of origin, and so on)? The catalog has no
    dedicated country-of-origin field; product attributes could hold it.
22. **Dark patterns.** Quotes carry a real, enforced expiry ("valid until 5:45 pm") and the seller agent may say
    "best and final price" on the last round or offer volume trades ("Take 3 and I can do ... each"). Is this
    presentation acceptable under the dark-pattern guidelines, and what wording avoids false urgency?
23. **Negotiated and personalised prices.** Two buyers can pay different prices for the same item depending on
    negotiation and quantity. Is disclosure required, and are there limits?
24. **Returns.** Return windows are set per product (0 to 90 days, default 7). Personalised items and items marked
    non-returnable (for example food) cannot be returned, and the current code refuses an online return for a
    whole order if any line is non-returnable. Is this lawful, in particular for damaged or defective goods? What
    refund timelines apply?
25. **Legal Metrology.** A database constraint stops any price above MRP, and negotiation only lowers prices.
    Which declarations must listings of pre-packaged goods show online (MRP, net quantity, manufacturer, best
    before, consumer care), and is anything else needed?
26. **Personalised text.** Customers choose text printed on products. A blocklist, trademark list and human review
    queue exist. What liability does the store carry for infringing or offensive text, and what terms should
    govern it?

## AI agents and contracts

27. **AI disclosure.** Must buyers be told that they negotiate with an automated seller agent, and how? Must the
    store disclose when replies are written by an LLM?
28. **Agent-to-agent contracts.** A buyer's AI agent can request quotes, make offers and accept a quote over MCP or
    A2A. Acceptance creates a checkout session; a person then confirms the address, accepts the terms and chooses
    payment before an order exists. Is that the moment a contract is formed? Is a signed quote an offer or an
    invitation to offer? How should actions of an agent be attributed to the person or business that authorised
    it?
29. **Statements in chat.** The seller agent's numbers come from code, and model-written text passes a guard,
    but wording about products, delivery or warranty could still be wrong. How should terms deal with errors in
    automated replies?
30. **Algorithmic pricing.** Prices come from the store's own costs and policy; no competitor data is used in
    v0.9. The planned v1.1 ops agents may read competitor prices from licensed feeds. What competition-law limits
    apply, and what must the store never do?

## Payments

31. **YouPI-PG.** The experimental adapter collects UPI payments into the operator's own account and detects them
    from bank alerts, using an observer app on the operator's phone. Its README says it is not bank-approved or
    audited. Does this fit the operator's bank terms and payment-system regulation, and are there KYC or
    payment-aggregator implications?
32. **Cash on delivery.** Are there rules on COD collection and remittance through couriers, and on how COD refunds
    must be made (they are manual today)?
33. **Refund timing and method.** What refund timelines and methods are required for gateway, UPI and COD orders?
34. **Gateway agreement.** What should the operator check in the Razorpay (or other gateway) agreement before
    switching from test to live keys, which the project treats as a human decision?

## Open source

35. **Operator responsibility.** The project is MIT-licensed without warranty and says each operator is
    responsible for compliance. Is that statement, and the drafts in this folder, clear enough for operators, and
    what should be added for operators outside India?
