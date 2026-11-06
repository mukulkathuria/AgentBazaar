import { describe, expect, it } from 'vitest';
import { findUuid, matchFaq, questionKey, searchTerms, skuCandidates } from './text.js';

describe('chat text rules', () => {
  it.each([
    ['show me dark chocolate under 500', 'dark chocolate'],
    ['need a graphics card under ₹60,000 please', 'graphics card'],
    ['mujhe ek kurta chahiye', 'kurta'],
    ['how much is it?', ''],
  ])('searchTerms(%j) = %j', (text, terms) => {
    expect(searchTerms(text)).toBe(terms);
  });

  it('matches an FAQ only on the same question, ignoring case and punctuation', () => {
    const faqs = [{ q: 'Does it work with a Mac?', a: 'Yes.' }];
    expect(matchFaq(faqs, 'does it work with a mac')).toBe('Yes.');
    expect(matchFaq(faqs, 'does it work with linux?')).toBeNull();
    expect(questionKey('Does it, work?')).toBe(questionKey('does it work'));
  });

  it('finds SKU-looking tokens and order ids', () => {
    expect(skuCandidates('is thock-tk87-red or MITTI-MUG-WHITE better than a t-shirt?')).toEqual(['THOCK-TK87-RED', 'MITTI-MUG-WHITE']);
    expect(findUuid('order 0B9A6C1E-3D2F-4A5B-8C7D-9E0F1A2B3C4D please')).toBe('0b9a6c1e-3d2f-4a5b-8c7d-9e0f1a2b3c4d');
    expect(findUuid('order AB-1234')).toBeNull();
  });
});
