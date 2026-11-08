'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const TRIES = 10;
const EVERY_MS = 2000;

/**
 * The order follows its payment through the outbox, so it can still read "awaiting payment" when the buyer lands
 * here from the gateway. Re-renders the page a few times until it moves on (the page stops rendering this then).
 */
export function PaymentWatcher() {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (tries >= TRIES) return;
    const id = setTimeout(() => {
      router.refresh();
      setTries(tries + 1);
    }, EVERY_MS);
    return () => clearTimeout(id);
  }, [tries, router]);
  return null;
}
