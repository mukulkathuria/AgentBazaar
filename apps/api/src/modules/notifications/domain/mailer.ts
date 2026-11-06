/** What an order email may carry. Delivery adapters resolve the address from the token themselves. */
export interface OrderEmail {
  template: string;
  orderNumber: string;
  customerToken: string;
}

/** Extension point for SMTP or an email API. */
export interface MailerPort {
  send(mail: OrderEmail): Promise<void>;
}

export const ORDER_EMAIL_TOPICS = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.delivered',
] as const;

/** Builds the email from an order event, or null when the payload is not an order event we understand. */
export function orderEmailFor(topic: string, payload: Record<string, unknown>): OrderEmail | null {
  const { number, customerToken } = payload;
  if (!(ORDER_EMAIL_TOPICS as readonly string[]).includes(topic)) return null;
  if (typeof number !== 'string' || typeof customerToken !== 'string') return null;
  return { template: topic, orderNumber: number, customerToken };
}
