// @vitest-environment jsdom
import { formatInr } from '@agentbazaar/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/en';
import { inr } from '@/lib/money';
import { renderWithProviders as render } from '@/test/render';
import { Price } from './price';

describe('price formatting', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(12_345_600)).toBe('₹1,23,456');
    expect(formatInr(1_234_567_89)).toBe('₹12,34,567.89');
    expect(formatInr(12_345_600, 'hi')).toContain('1,23,456');
  });

  it('client formatter matches the contracts formatter exactly', () => {
    for (const paise of [0, 1, 99, 100, 49_900, 12_345_600, 123_456_789, 1_000_000_000]) {
      for (const lang of ['en', 'hi'] as const) expect(inr(paise, lang)).toBe(formatInr(paise, lang));
    }
  });

  it('shows the selling price, the MRP and the discount', () => {
    render(<Price pricePaise={12_345_600} mrpPaise={15_000_000} lang="en" t={en.product} large />);
    expect(screen.getByText('₹1,23,456')).toBeTruthy();
    expect(screen.getByText('₹1,50,000').tagName).toBe('S');
    expect(screen.getByText('18% off')).toBeTruthy();
  });

  it('shows a range for products with several prices and no discount when MRP equals price', () => {
    render(<Price pricePaise={99_900} maxPricePaise={1_49_900} mrpPaise={99_900} lang="en" t={en.product} />);
    expect(screen.getByText('₹999 – ₹1,499')).toBeTruthy();
    expect(screen.queryByText(/off$/)).toBeNull();
  });
});
