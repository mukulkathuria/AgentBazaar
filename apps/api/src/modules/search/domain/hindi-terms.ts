/**
 * Hindi (Devanagari) words a shopper may type, mapped to the words the catalog is written in: English for
 * product types, and the catalog's own Hinglish spelling for brands. Search documents carry no Devanagari, so
 * without this a Hindi query finds nothing in any engine. The category names are the catalog's own Hindi
 * names (CATEGORIES.nameHi in @agentbazaar/testkit). Reviewed by hand; extend it as data, not code.
 */
export const HINDI_TERMS: Readonly<Record<string, string>> = {
  // Categories
  'इलेक्ट्रॉनिक्स': 'electronics',
  'पीसी पार्ट्स': 'pc components',
  'ग्राफ़िक्स कार्ड': 'graphics card',
  'पावर सप्लाई': 'power supply',
  'पीसी केस': 'pc case',
  'एक्सेसरीज़': 'accessories',
  'कीबोर्ड': 'keyboard',
  'माउस': 'mouse',
  'खाद्य': 'food',
  'चॉकलेट': 'chocolate',
  'चाय': 'tea',
  'घर और रसोई': 'home kitchen',
  'मग': 'mug',
  'कपड़े': 'apparel',
  'टी-शर्ट': 't-shirt',
  'टीशर्ट': 't-shirt',
  'स्टेशनरी': 'stationery',
  'नोटबुक': 'notebook',
  // Common product words
  'कप': 'mug',
  'कॉपी': 'notebook',
  'डायरी': 'journal',
  'कॉफ़ी': 'coffee',
  'डार्क': 'dark',
  'मिल्क': 'milk',
  'दूध': 'milk',
  'ग्रीन': 'green',
  'हरी': 'green',
  'मसाला चाय': 'masala chai',
  'गेमिंग': 'gaming',
  'वायरलेस': 'wireless',
  'मैकेनिकल': 'mechanical',
  // Brands, as the catalog spells them
  'चाय कहानी': 'chai kahani',
  'मिठास': 'mithas',
  'कुम्हार': 'kumhar',
  'कागज़': 'kagaz',
  'मिट्टी': 'mitti',
  'पहाड़ी': 'pahadi',
  'देसी': 'desi',
};

// Nukta spellings vary (ज़ or ज), so both sides are compared without it. NFC keeps U+0958-095F decomposed.
const NUKTA = String.fromCodePoint(0x093c);
const fold = (s: string) => s.normalize('NFC').replaceAll(NUKTA, '');
// Regex syntax characters; a hyphen needs no escape outside a class (and may not have one with the u flag).
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first, so a phrase ("चाय कहानी") wins over its words ("चाय"); words end at spaces or punctuation.
const TERMS = Object.entries(HINDI_TERMS)
  .map(([hindi, catalog]) => [fold(hindi), catalog] as const)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([hindi, catalog]) => [new RegExp(`(?<=^|[\\s,.;:!?()])${escape(hindi)}(?=$|[\\s,.;:!?()])`, 'gu'), catalog] as const);
const DEVANAGARI = /\p{Script=Devanagari}/u;

/** The query with every Hindi word or phrase of HINDI_TERMS in the catalog's words; anything else is kept as typed. */
export function translateHindi(q: string): string {
  if (!DEVANAGARI.test(q)) return q;
  return TERMS.reduce((text, [hindi, catalog]) => text.replace(hindi, catalog), fold(q));
}
