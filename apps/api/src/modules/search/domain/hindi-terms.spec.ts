import { describe, expect, it } from 'vitest';
import { HINDI_TERMS, translateHindi } from './hindi-terms.js';

describe('@lite Hindi query terms', () => {
  it.each([
    ['कीबोर्ड', 'keyboard'],
    ['चॉकलेट', 'chocolate'],
    ['माउस', 'mouse'],
    ['चाय', 'tea'],
    ['कप', 'mug'],
    ['पावर सप्लाई', 'power supply'],
    ['डार्क चॉकलेट', 'dark chocolate'],
    ['मिठास चॉकलेट', 'mithas chocolate'],
  ])('reads %s as "%s"', (hindi, catalog) => {
    expect(translateHindi(hindi)).toBe(catalog);
  });

  it('prefers a phrase to its words', () => {
    expect(translateHindi('चाय कहानी')).toBe('chai kahani');
    expect(translateHindi('मसाला चाय')).toBe('masala chai');
    expect(translateHindi('हरी चाय')).toBe('green tea');
  });

  it('matches with or without the nukta', () => {
    expect(translateHindi('ग्राफिक्स कार्ड')).toBe('graphics card');
    expect(translateHindi('ग्राफ़िक्स कार्ड')).toBe('graphics card');
    expect(translateHindi('कागज नोटबुक')).toBe('kagaz notebook');
  });

  it('keeps everything else as typed and never replaces part of a word', () => {
    expect(translateHindi('THOCK कीबोर्ड, लाल')).toBe('THOCK keyboard, लाल');
    expect(translateHindi('मगर')).toBe('मगर');
    expect(translateHindi('keyboard under 5000')).toBe('keyboard under 5000');
  });

  it('maps only Devanagari to lower-case catalog words', () => {
    for (const [hindi, catalog] of Object.entries(HINDI_TERMS)) {
      expect(hindi, catalog).toMatch(/\p{Script=Devanagari}/u);
      expect(catalog, hindi).toMatch(/^[a-z0-9 -]+$/);
    }
  });
});
