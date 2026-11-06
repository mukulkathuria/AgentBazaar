// @vitest-environment jsdom
import type { ChatReply } from '@agentbazaar/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/render';
import { ChatWidget } from './chat-widget';

const SESSION = '9b2d5c1e-3f4a-4b6c-8d7e-1a2b3c4d5e6f';
const CHECKOUT = '2c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';

function sseStream() {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, push: (s: string) => controller.enqueue(enc.encode(s)), end: () => controller.close() };
}

function reply(expiresInMs: number): ChatReply {
  return {
    sessionId: SESSION,
    message: 'Deal! ₹2,199 each for 2 keyboards.',
    tier: 1,
    intent: 'make_offer',
    products: [],
    negotiation: {
      negotiationId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
      state: 'quote',
      decision: 'countered',
      quote: {
        quoteId: '6e7f8a9b-0c1d-4e2f-9a3b-4c5d6e7f8a9b',
        token: 'signed-quote-token-0123456789',
        negotiationId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
        sku: 'TK87-RED',
        productName: 'Thock TK87',
        quantity: 2,
        unitPricePaise: 219_900,
        listUnitPricePaise: 249_900,
        totalPaise: 439_800,
        currency: 'INR',
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        status: 'active',
        terms: [],
      },
      alternatives: [{ quantity: 3, unitPricePaise: 209_900, reason: 'volume' }],
      round: 1,
      roundsRemaining: 2,
      message: 'Countered',
      reasonCodes: [],
    },
    checkoutUrl: `http://localhost:3000/checkout/${CHECKOUT}?t=cap-token`,
    handoff: false,
    tokensRemaining: 1000,
  };
}

describe('ChatWidget', () => {
  it('streams tokens, then shows the offer card with a live countdown and the checkout button', async () => {
    const sse = sseStream();
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/chat/sessions')
        ? jsonResponse({ sessionId: SESSION, language: 'en', greeting: 'Namaste! How can I help?' }, 201)
        : new Response(sse.stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<ChatWidget />);

    const launcher = screen.getByRole('button', { name: 'Chat with our shopping assistant' });
    fireEvent.click(launcher);
    const dialog = screen.getByRole('dialog', { name: 'Shopping assistant' });
    expect(await within(dialog).findByText('Namaste! How can I help?')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Your message'));

    fireEvent.change(within(dialog).getByLabelText('Your message'), { target: { value: 'Two keyboards for 2000 each?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    sse.push('event: token\ndata: Let me');
    sse.push('\n\nevent: token\ndata:  check\n\n');
    expect(await within(dialog).findByText('Let me check')).toBeTruthy();
    expect(within(dialog).getByRole('log').getAttribute('aria-live')).toBe('polite');

    sse.push(`event: reply\ndata: ${JSON.stringify(reply(125_000))}\n\n`);
    sse.end();
    expect(await within(dialog).findByText('Deal! ₹2,199 each for 2 keyboards.')).toBeTruthy();

    const timer = within(dialog).getByRole('timer');
    expect(timer.textContent).toMatch(/^Offer expires in 2:0[0-5]$/);
    const first = timer.textContent;
    await waitFor(() => expect(timer.textContent).not.toBe(first), { timeout: 2_500 });
    expect(within(dialog).getByText('₹2,199 each')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Buy 3 at ₹2,099 each' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe(`/checkout/${CHECKOUT}?t=cap-token`);

    const [, sendInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(sendInit.headers).get('accept')).toBe('text/event-stream');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it('shows a friendly message when the assistant is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));
    renderWithProviders(<ChatWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat with our shopping assistant' }));
    expect(await screen.findByText('Sorry, the assistant is unavailable right now. Please try again.')).toBeTruthy();
  });
});
