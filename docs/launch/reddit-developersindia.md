# r/developersIndia draft

Status: DRAFT. Before posting: check the subreddit's current rules (it may require a specific flair or a
specific day for project showcases), and fill or delete every metric marker.

## Title

`Open-source store with GST, UPI, COD and DPDP support where AI agents can haggle (MIT)`

## Body

I have been building AgentBazaar, an open-source commerce platform for Indian sellers where AI agents can
shop and negotiate over MCP and A2A, alongside a normal storefront. It is MIT-licensed and self-hosted.
Sharing it here because the India-specific parts were the hardest to get right, and I would like feedback
from people who have shipped them in production.

What it handles:

- **Money as integer paise.** No floats anywhere in pricing. Rupee inputs from agents are parsed to paise
  and rejected if they have more than two decimals or exceed ₹1 crore. Display uses Indian grouping
  (₹1,23,456.78).
- **GST per line.** Prices are GST-inclusive. Each line is split into taxable value and tax, with CGST plus
  SGST for intra-state supply and IGST for inter-state supply, and tax computed as total minus taxable so
  the parts always add up to the paisa. Invoice numbers are gap-free per financial year (April to March,
  IST), like `INV/2026-27/000001`. The GST rates in the seed data are illustrative only.
- **UPI and COD.** A Razorpay adapter (written from the public docs, not yet verified against the live
  sandbox), an experimental self-hosted UPI adapter (YouPI-PG, where a bank alert is only "observed" and an
  order ships only after "reconciled"), and cash on delivery, where "order placed" is never treated as
  "money received".
- **DPDP Act 2023 features.** Consent records with the notice version, data export, erasure by
  crypto-shredding (each customer has their own encryption key, and erasure deletes it), retention jobs and
  a grievance contact. Whether this meets your obligations is a question for your counsel; the repo ships a
  compliance pack to make that review quicker, not legal advice.
- **Hindi and Hinglish.** Seller replies have Hindi templates. Customization text accepts Devanagari and
  counts length by what a reader sees (graphemes), and prompt-injection patterns include Hinglish phrasings.
  Indian mobile numbers and PIN codes are validated at checkout.

The AI seller can negotiate, but every number comes from the pricing engine, never from the model. On the
demo keyboard (list ₹5,499) it goes ₹5,499, ₹5,472, ₹5,390, ₹5,253 and stops at ₹5,060, and offers "Take 3
and I can do ₹5,364 each" instead of just discounting.

Try it without API keys (Node.js 22.12 or later, pnpm 12):

    git clone https://github.com/mukulkathuria/AgentBazaar && cd AgentBazaar && pnpm install && pnpm demo

Status: v0.9 lite release candidate for one VPS. Not for real money before an independent security review.

I would especially value input on GST e-invoicing thresholds, UPI reconciliation in practice, and DPDP
consent flows you have seen work.

Repository: https://github.com/mukulkathuria/AgentBazaar
