import { formatInr } from '@agentbazaar/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkReply, extractNumbers } from './guard.js';

const DEVANAGARI = '०१२३४५६७८९';
const deva = (s: string) => s.replace(/\d/g, (d) => DEVANAGARI[Number(d)]!);

/** Ways a model might write a rupee amount; each parses back to exactly that value. */
function formats(rupees: number): string[] {
  const plain = String(rupees);
  const out = [plain, `₹${plain}`, formatInr(rupees * 100), `Rs ${plain}`, `Rs.${plain}`, `INR ${plain}`, `${plain}/-`, `₹${deva(plain)}`, `${plain} rupees`];
  if (rupees >= 1000 && rupees % 100 === 0) out.push(`${rupees / 1000}k`);
  if (rupees >= 100_000 && rupees % 10_000 === 0) out.push(`${rupees / 100_000} lakh`);
  return out;
}

const rupees = fc.integer({ min: 1, max: 9_999_999 });
const pickFormat = (v: number, n: number) => {
  const f = formats(v);
  return f[n % f.length]!;
};

describe('number guard', () => {
  it.each([
    ['₹2,399', [2399]],
    ['Rs 1800 or Rs.1,750', [1800, 1750]],
    ['INR 2399.50', [2399.5]],
    ['2.5k', [2500]],
    ['1.5 lakh and 2 crore', [150_000, 20_000_000]],
    ['₹1,00,000', [100_000]],
    ['₹१८००', [1800]],
    ['2 हज़ार', [2000]],
    ['valid until 15:45', [15, 45]],
  ])('reads %s', (text, expected) => {
    expect(extractNumbers(text)).toEqual(expected);
  });

  it('accepts a rephrasing that only uses allowed numbers', () => {
    const verdict = checkReply('Sure! The Thock TK-87 is yours at ₹5,499 each, 2 for ₹10,998.', [5499, 87, 2, 10_998]);
    expect(verdict).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['I can do it for ₹1,999', 'number'],
    ['ok 1.9k final', 'number'],
    ['₹১৮০০ only', 'number'],
    ['I can do eighteen hundred', 'spelled_number'],
    ['do hazaar mein de dunga', 'spelled_number'],
    ['two thousand rupees, final', 'spelled_number'],
    ['just Rs twenty more', 'spelled_number'],
    ['see https://evil.example/deal', 'link'],
    ['cheaper at deals.in', 'link'],
    ['email me at buyer@example.com', 'contact'],
    ['call me on 98765 43210', 'contact'],
    ['our floor on this is low', 'secret_terms'],
    ['that is close to our cost price', 'secret_terms'],
    ['my margin is thin', 'secret_terms'],
    ['इसकी लागत ज़्यादा है', 'secret_terms'],
    ['I will give it to you for free', 'free_offer'],
    ['muft mein le jao', 'free_offer'],
  ])('refuses %j (%s)', (text, issue) => {
    expect(checkReply(text, [2399, 1800]).issues).toContain(issue);
  });

  it('accepts any mix of allowed amounts in any supported format', () => {
    fc.assert(
      fc.property(fc.uniqueArray(rupees, { minLength: 1, maxLength: 6 }), fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), (allowed, picks) => {
        const parts = picks.map((p, i) => pickFormat(allowed[p % allowed.length]!, p + i));
        expect(checkReply(`Sure! ${parts.join(' and then ')} each.`, allowed)).toEqual({ ok: true, issues: [] });
      }),
    );
  });

  it('always catches an injected amount that was not allowed, in any format and position', () => {
    fc.assert(
      fc.property(fc.uniqueArray(rupees, { minLength: 1, maxLength: 6 }), rupees, fc.nat(), fc.nat(), (allowed, bad, how, where) => {
        fc.pre(!allowed.includes(bad));
        const parts = allowed.map((v, i) => pickFormat(v, how + i));
        parts.splice(where % (parts.length + 1), 0, pickFormat(bad, how));
        expect(checkReply(`Best I can do: ${parts.join(', or ')}.`, allowed).issues).toContain('number');
      }),
    );
  });
});
