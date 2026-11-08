// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentWatcher } from './payment-watcher';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  refresh.mockReset();
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('PaymentWatcher (regression: paid orders showed "Awaiting payment" after the mock gateway redirect)', () => {
  it('re-renders the order every 2 s, ten times at most', async () => {
    vi.useFakeTimers();
    render(<PaymentWatcher />);
    await tick(1999);
    expect(refresh).not.toHaveBeenCalled();
    await tick(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) await tick(2000);
    expect(refresh).toHaveBeenCalledTimes(10);
  });

  it('stops once the order has moved on and the page no longer renders it', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<PaymentWatcher />);
    await tick(2000);
    unmount();
    await tick(20_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
