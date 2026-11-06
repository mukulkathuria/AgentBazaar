export const LEGAL_DOCS = ['terms', 'privacy', 'returns'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

interface LegalSection {
  heading: string;
  body: string[];
}

/** DRAFT templates only. Placeholders in [brackets] must be completed and reviewed by a lawyer. */
export const LEGAL_CONTENT: Record<LegalDoc, LegalSection[]> = {
  terms: [
    {
      heading: 'Who we are',
      body: ['These terms govern purchases from [Seller legal name], GSTIN [GSTIN], [registered address], India.'],
    },
    {
      heading: 'Prices, quotes and negotiation',
      body: [
        'Prices are in Indian rupees and include GST unless stated otherwise.',
        'Our shopping assistant and buyer AI agents may negotiate prices. Every offer is checked by a pricing policy with minimum prices enforced in code. A negotiated price is valid only for the quantity and until the expiry time shown on the quote.',
        'A quote becomes an order only after a human confirms the delivery address and payment method at checkout.',
      ],
    },
    {
      heading: 'Orders and payment',
      body: [
        'We may cancel an order if an item is out of stock or a price was shown in error; any amount paid is refunded in full.',
        'Cash on delivery is available for eligible orders up to [limit].',
      ],
    },
    {
      heading: 'Personalised items',
      body: ['Items made with your text or design are produced for you and cannot be returned unless they arrive damaged or defective.'],
    },
    {
      heading: 'Governing law',
      body: ['These terms are governed by the laws of India. Courts at [city] have jurisdiction.'],
    },
  ],
  privacy: [
    {
      heading: 'What we collect',
      body: [
        'Account details (name, email), delivery addresses, phone number, order history and chat messages with our assistant.',
        'Personal data is encrypted at rest. We do not sell personal data.',
      ],
    },
    {
      heading: 'Why we use it',
      body: [
        'To deliver orders (order fulfilment), to send marketing only if you opt in, and for product analytics only if you opt in.',
        'You can change these choices at any time on your account page.',
      ],
    },
    {
      heading: 'Your rights under the DPDP Act, 2023',
      body: [
        'You can download a copy of your data and erase your account from your account page.',
        'Records we must keep by law (for example GST invoices) are retained in anonymised form for [period].',
      ],
    },
    {
      heading: 'Contact',
      body: ['Questions or complaints: our grievance officer, whose contact is listed in the footer of every page.'],
    },
  ],
  returns: [
    {
      heading: 'Return window',
      body: [
        'Most items can be returned within the number of days shown on the product page, counted from delivery.',
        'Request a return from your order page. We arrange pickup at no cost for damaged, wrong or not-as-described items.',
      ],
    },
    {
      heading: 'Non-returnable items',
      body: ['Personalised items and items marked non-returnable on the product page cannot be returned unless damaged or defective.'],
    },
    {
      heading: 'Refunds',
      body: [
        'Refunds go to the original payment method within [7] working days of the returned item passing inspection.',
        'For cash on delivery orders we refund to a bank account or UPI ID you provide.',
      ],
    },
  ],
};
