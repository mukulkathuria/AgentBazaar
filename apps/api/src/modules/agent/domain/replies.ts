import {
  type Availability,
  type CheckoutLink,
  type CustomizationOptions,
  type CustomizationValidation,
  formatInr,
  type Language,
  type OrderView,
  type ProductSummary,
  type PublicProduct,
} from '@agentbazaar/contracts';

/**
 * Template wording for every chat reply. Numbers come only from service results passed in here;
 * a model may rephrase these strings, but the guard rejects any number that is not in them.
 */
type Bilingual = { en: string; hi: string };
const say = (lang: Language, t: Bilingual): string => t[lang];
const time = (iso: string, lang: Language) =>
  new Date(iso).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const HUMAN_HINT: Bilingual = { en: 'Type "human" to talk to a person.', hi: 'किसी व्यक्ति से बात करने के लिए "human" लिखें।' };

export const canned = {
  greeting: (lang: Language, seller: string) =>
    say(lang, {
      en: `Namaste! I'm the ${seller} shopping assistant. I can find products, check stock, personalise items and agree a price with you. What are you looking for?`,
      hi: `नमस्ते! मैं ${seller} का शॉपिंग असिस्टेंट हूँ। मैं प्रोडक्ट ढूँढने, स्टॉक देखने, पर्सनलाइज़ करने और कीमत तय करने में मदद कर सकता हूँ। आप क्या ढूँढ रहे हैं?`,
    }),
  offTopic: (lang: Language) =>
    say(lang, {
      en: 'I can only help with shopping here: products, prices, personalisation, orders and returns. What can I find for you?',
      hi: 'मैं यहाँ सिर्फ़ ख़रीदारी में मदद कर सकता हूँ: प्रोडक्ट, कीमत, पर्सनलाइज़ेशन, ऑर्डर और रिटर्न। आपके लिए क्या ढूँढूँ?',
    }),
  refuseInstructions: (lang: Language) =>
    say(lang, {
      en: "I can't change how I work or share internal details, but I'm happy to help you shop. What are you looking for?",
      hi: 'मैं अपने काम करने का तरीका नहीं बदल सकता और अंदरूनी जानकारी साझा नहीं कर सकता, लेकिन ख़रीदारी में ज़रूर मदद करूँगा। आप क्या ढूँढ रहे हैं?',
    }),
  budgetExhausted: (lang: Language) =>
    say(lang, {
      en: `I've reached my limit for this chat. ${HUMAN_HINT.en}`,
      hi: `इस चैट के लिए मेरी सीमा पूरी हो गई है। ${HUMAN_HINT.hi}`,
    }),
  handoff: (lang: Language) =>
    say(lang, {
      en: "I've asked a person from our team to take over this chat. They'll reply here shortly.",
      hi: 'मैंने हमारी टीम के एक व्यक्ति से यह चैट संभालने को कहा है। वे जल्द ही यहाँ जवाब देंगे।',
    }),
  needProduct: (lang: Language) =>
    say(lang, {
      en: 'Which product do you mean? Tell me its name or SKU, or ask me to search.',
      hi: 'आप किस प्रोडक्ट की बात कर रहे हैं? उसका नाम या SKU बताइए, या मुझसे खोजने को कहिए।',
    }),
  noQuote: (lang: Language) =>
    say(lang, {
      en: "There's no open quote to accept yet. Ask me for a price first.",
      hi: 'अभी स्वीकार करने के लिए कोई खुला कोट नहीं है। पहले मुझसे कीमत पूछिए।',
    }),
  askOrderId: (lang: Language) =>
    say(lang, { en: 'Please share your order ID and I will check its status.', hi: 'कृपया अपना ऑर्डर आईडी बताइए, मैं उसका स्टेटस देखता हूँ।' }),
  orderNotFound: (lang: Language) =>
    say(lang, {
      en: "I couldn't find that order for this chat. Sign in, or use the tracking link from your order confirmation.",
      hi: 'इस चैट के लिए वह ऑर्डर नहीं मिला। साइन इन करें, या ऑर्डर कन्फ़र्मेशन वाले ट्रैकिंग लिंक का इस्तेमाल करें।',
    }),
  returns: (lang: Language) =>
    say(lang, {
      en: `You can request a return from your order page within the product's return window. Personalised and food items can't be returned unless they arrive damaged. ${HUMAN_HINT.en}`,
      hi: `आप प्रोडक्ट की रिटर्न अवधि में अपने ऑर्डर पेज से रिटर्न माँग सकते हैं। पर्सनलाइज़्ड और खाने की चीज़ें तभी लौटती हैं जब वे टूटी-फूटी आएँ। ${HUMAN_HINT.hi}`,
    }),
  complaint: (lang: Language) =>
    say(lang, {
      en: `I'm sorry about that. I've noted it and a teammate can help. ${HUMAN_HINT.en}`,
      hi: `इसके लिए माफ़ी चाहता हूँ। मैंने इसे नोट कर लिया है और हमारी टीम मदद कर सकती है। ${HUMAN_HINT.hi}`,
    }),
  capabilities: (lang: Language) =>
    say(lang, {
      en: 'I can help you find products, check prices and stock, personalise items, negotiate a price and check out. What would you like?',
      hi: 'मैं प्रोडक्ट ढूँढने, कीमत और स्टॉक देखने, पर्सनलाइज़ करने, मोलभाव करने और चेकआउट में मदद कर सकता हूँ। आप क्या चाहेंगे?',
    }),
  failed: (lang: Language) =>
    say(lang, { en: "Sorry, I couldn't do that right now. Please try again in a moment.", hi: 'माफ़ कीजिए, अभी यह नहीं हो पाया। कृपया थोड़ी देर बाद फिर कोशिश करें।' }),
};

export function searchResults(items: readonly ProductSummary[], lang: Language): string {
  if (!items.length) {
    return say(lang, { en: "I couldn't find anything for that. Try other words or a different budget.", hi: 'इसके लिए कुछ नहीं मिला। दूसरे शब्द या अलग बजट आज़माइए।' });
  }
  const list = items.map((p, i) => `${i + 1}. ${p.name} (${p.defaultSku}) ${formatInr(p.minPricePaise, lang)}`).join('; ');
  return say(lang, { en: `Here are some options: ${list}.`, hi: `ये विकल्प हैं: ${list}।` });
}

export function productAnswer(p: PublicProduct, faq: string | null, lang: Language): string {
  if (faq) return faq;
  const v = p.variants[0]!;
  return say(lang, {
    en: `${p.name} by ${p.brand}: ${p.description} Price ${formatInr(v.pricePaise, lang)}.`,
    hi: `${p.brand} का ${p.name}: ${p.description} कीमत ${formatInr(v.pricePaise, lang)}।`,
  });
}

export function availability(a: Availability, name: string, lang: Language): string {
  if (!a.inStock) return say(lang, { en: `${name} (${a.sku}) is out of stock right now.`, hi: `${name} (${a.sku}) अभी स्टॉक में नहीं है।` });
  if (!a.canFulfilQuantity) {
    return say(lang, {
      en: `${name} (${a.sku}) is in stock, but only ${a.availableQty} are available.`,
      hi: `${name} (${a.sku}) स्टॉक में है, लेकिन सिर्फ़ ${a.availableQty} उपलब्ध हैं।`,
    });
  }
  return say(lang, { en: `${name} (${a.sku}) is in stock and ready to ship.`, hi: `${name} (${a.sku}) स्टॉक में है और भेजने के लिए तैयार है।` });
}

export function customization(o: CustomizationOptions, name: string, lang: Language): string {
  const fields = o.fields.map((f) => `${f.label} (${f.maxLength})`).join(', ');
  const fee = formatInr(o.surchargePaise, lang);
  return say(lang, {
    en: `${name} can be personalised: ${fields}. Personalisation adds ${fee}. ${o.notice}`,
    hi: `${name} को पर्सनलाइज़ किया जा सकता है: ${fields}। इसके लिए ${fee} अतिरिक्त लगेंगे। पर्सनलाइज़्ड चीज़ें वापस नहीं होतीं।`,
  });
}

export function customizationVerdict(v: CustomizationValidation, lang: Language): string {
  if (v.verdict === 'approved') return say(lang, { en: 'That text works and can be printed.', hi: 'यह टेक्स्ट ठीक है और छप सकता है।' });
  if (v.verdict === 'needs_review') {
    return say(lang, { en: 'That text needs a quick human check before printing.', hi: 'छपाई से पहले इस टेक्स्ट को एक बार इंसानी जाँच चाहिए।' });
  }
  const why = v.issues.map((i) => i.message).join('; ');
  return say(lang, { en: `That text can't be printed: ${why}.`, hi: `यह टेक्स्ट छप नहीं सकता: ${why}।` });
}

export function competitorClaim(currentUnitPaise: number | null, lang: Language): string {
  const price = currentUnitPaise === null ? null : formatInr(currentUnitPaise, lang);
  return say(lang, {
    en: `Thanks for letting me know. I can't verify prices from other stores, so I can't match them.${price ? ` My price stays ${price} each.` : ' Ask me for a quote and I will give you my best price.'}`,
    hi: `बताने के लिए धन्यवाद। मैं दूसरी दुकानों की कीमतें जाँच नहीं सकता, इसलिए उनसे मिलान नहीं कर सकता।${price ? ` मेरी कीमत ${price} प्रति पीस ही रहेगी।` : ' मुझसे कोट माँगिए, मैं अपनी सबसे अच्छी कीमत बताऊँगा।'}`,
  });
}

export function checkoutReady(link: CheckoutLink, lang: Language): string {
  const total = formatInr(link.amountPaise, lang);
  return say(lang, {
    en: `Great! Your secure checkout link is ready for ${total}. A person opens it to confirm the address and pay before ${time(link.expiresAt, lang)}.`,
    hi: `बढ़िया! ${total} के लिए आपका सुरक्षित चेकआउट लिंक तैयार है। ${time(link.expiresAt, lang)} से पहले इसे खोलकर पता पक्का करें और भुगतान करें।`,
  });
}

export function orderStatus(o: OrderView, lang: Language): string {
  const status = o.status.replace(/_/g, ' ');
  const tracking = o.trackingNumber ? say(lang, { en: ` Tracking: ${o.trackingNumber}.`, hi: ` ट्रैकिंग: ${o.trackingNumber}।` }) : '';
  return say(lang, { en: `Order ${o.number} is ${status}.${tracking}`, hi: `ऑर्डर ${o.number} की स्थिति: ${status}।${tracking}` });
}
