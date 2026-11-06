'use client';

import type { NegotiationOutcome } from '@agentbazaar/contracts';
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ui';
import { fmt } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { inr } from '@/lib/money';

/** Milliseconds left until `expiresAt`, ticking every second until it reaches zero. */
export function useCountdown(expiresAt: string | null): number {
  const target = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(target)) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= target) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [target]);
  return Number.isNaN(target) ? 0 : Math.max(0, target - now);
}

export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function VolumeOptions({ negotiation, onSend, disabled }: OfferProps) {
  const { t, lang } = useI18n();
  if (!negotiation.alternatives.length) return null;
  return (
    <ul className="space-y-2">
      {negotiation.alternatives.map((alt) => {
        const vars = { qty: alt.quantity, price: inr(alt.unitPricePaise, lang) };
        return (
          <li key={alt.quantity}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSend(fmt(t.chat.volumeText, vars))}
              className={buttonClass('secondary', 'w-full')}
            >
              {fmt(t.chat.volume, vars)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface OfferProps {
  negotiation: NegotiationOutcome;
  onSend: (text: string) => void;
  disabled: boolean;
}

/** A signed quote from the pricing engine, with a live expiry countdown and volume alternatives. */
export function OfferCard({ negotiation, onSend, disabled }: OfferProps) {
  const { t, lang } = useI18n();
  const quote = negotiation.quote;
  const remaining = useCountdown(quote?.expiresAt ?? null);
  if (!quote) return null;
  const expired = remaining <= 0;
  const price = (paise: number) => inr(paise, lang);
  const title = fmt(t.chat.offer, { qty: quote.quantity, name: quote.productName });
  return (
    <section aria-label={title} className="mt-2 space-y-2 rounded-lg border border-blue-700 bg-blue-50 p-3 text-sm text-gray-900">
      <p className="font-semibold">{title}</p>
      <p className="text-lg font-bold">{fmt(t.chat.perUnit, { price: price(quote.unitPricePaise) })}</p>
      {quote.listUnitPricePaise > quote.unitPricePaise && (
        <p className="text-gray-700">
          <s>{fmt(t.chat.listPrice, { price: price(quote.listUnitPricePaise) })}</s>
        </p>
      )}
      <p>{fmt(t.chat.total, { price: price(quote.totalPaise) })}</p>
      <p role="timer" aria-live="off" className={expired ? 'font-semibold text-red-700' : 'font-semibold'}>
        {expired ? t.chat.expired : fmt(t.chat.expiresIn, { time: clock(remaining) })}
      </p>
      {!expired && negotiation.roundsRemaining > 0 && <p>{fmt(t.chat.roundsLeft, { n: negotiation.roundsRemaining })}</p>}
      {!expired && <VolumeOptions negotiation={negotiation} onSend={onSend} disabled={disabled} />}
      {!expired && (
        <Button disabled={disabled} onClick={() => onSend(t.chat.acceptText)} className="w-full">
          {t.chat.accept}
        </Button>
      )}
    </section>
  );
}
