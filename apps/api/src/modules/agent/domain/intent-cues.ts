import type { Intent } from '@agentbazaar/contracts';

/*
 * Cue tables of the rules-v1 intent classifier, ported verbatim from services/ai classifier.py.
 * Each rx`...` table is one whole-word regex over `|`-separated alternatives in Python `re` syntax,
 * written in lower case and canonical form; line breaks inside a table are layout only.
 */

/** Python's Unicode `\w` as class contents (JS `\w` is ASCII-only, even with the u flag). */
export const WORD = String.raw`\p{L}\p{N}_`;
/** Python's `_W`: word chars incl. Devanagari vowel signs/virama and digits (no dandas). */
const W = String.raw`\u0900-\u0963\u0966-\u097F${WORD}`;
export const B = `(?<![${W}])`;
export const E = `(?![${W}])`;

/** NFKC, nukta dropped, chandrabindu -> anusvara, curly apostrophes straightened. */
export const canon = (s: string): string =>
  s.normalize('NFKC').replaceAll('\u093C', '').replaceAll('\u0901', '\u0902').replace(/[\u2018\u2019]/g, "'");

const ND = /\p{Nd}/u;
/**
 * Any decimal digit as ASCII, since Python's `\d`, float() and int() take them all: Nd digits come in
 * contiguous runs of ten from 0, so a digit's value is its distance from the start of its block, mod 10.
 */
function asciiDigit(d: string): string {
  const cp = d.codePointAt(0) ?? 0;
  let start = cp;
  while (ND.test(String.fromCodePoint(start - 1))) start--;
  return String((cp - start) % 10);
}

/** The text every cue runs on: canonical, case-folded, single-spaced, with ASCII digits. */
export const fold = (text: string): string =>
  canon(text)
    .toLowerCase()
    .replaceAll('ß', 'ss') // casefold() beyond lower(): only ß is reproduced (not ǰ ẖ ẗ ẘ ẙ, Greek, Cherokee)
    .replace(/\p{Nd}/gu, asciiDigit)
    .split(/\p{White_Space}+/u) // str.split(): Python's whitespace minus \x1c-\x1f
    .filter(Boolean)
    .join(' ');

/** String.raw minus line breaks and the indentation after them, so long patterns can wrap. */
export const raw = (s: TemplateStringsArray, ...subs: string[]): string =>
  String.raw(s, ...subs).replace(/\n */g, '');

/** `_rx`: one whole-word regex over a table of alternatives. */
const rx = (s: TemplateStringsArray): RegExp =>
  new RegExp(`${B}(?:${canon(raw(s)).replaceAll('\\w', `[${WORD}]`)})${E}`, 'gu');

const words = (s: TemplateStringsArray): ReadonlySet<string> => new Set(fold(s.raw.join(' ')).split(' '));

export const CUES = {
  injection_attempt: rx`
    ignore (?:all |any |the |your |my |of |these |those )*(?:previous |prior |above |earlier |preceding |
    past |last |system |initial |original |existing )*(?:instructions?|prompts?|rules|directions|guidelines|
    programming|training)|
    disregard (?:all |any |the |your |of )*(?:previous |prior |above |earlier |preceding |
    system )*(?:instructions?|prompts?|rules|directions|guidelines|programming)|
    forget (?:all |any |the |your |about )*(?:previous |prior |above |earlier |preceding |
    system )*(?:instructions?|prompts?|rules|guidelines|programming|training)|
    (?:override|bypass|disable|turn off) (?:all |any |the |your )*(?:instructions?|rules|safety\w*|
    guardrails?|filters?|restrictions?|limits?)|system ?prompts?|system messages?|
    (?:initial|hidden|original|secret) (?:prompt|instructions)|prompt injection|
    you(?:'re| are) now (?:a |an |my |the |in |no longer|free|unrestricted|unfiltered|jailbroken|going to|
    dan)|from now on,? you (?:are|will|must|should)|
    act as (?:an? |my |the )?(?:unrestricted|unfiltered|jailbroken|evil|dan|developer|admin|root|system)|
    (?:developer|dev|god|admin|debug|sudo|unrestricted) mode|jail ?break\w*|pretend\w*|role[ -]?play\w*|
    do anything now|
    (?:reveal|show|tell|give|share|leak|print|display|expose|disclose|dump|output|repeat) (?:me |
    us )?(?:your|ur|the system'?s?|the hidden|the internal|the secret|internal|hidden|secret|
    system) (?:actual |real |exact |internal |hidden |secret |full |original )*(?:rules|instructions|prompt|
    system prompt|guardrails|floor(?: price)?|margins?|cost price|purchase price|wholesale price|
    buying price|reserve price|base price)|
    (?:reveal|show|tell|give|share|leak|print|display|expose|disclose|dump|output) (?:me |
    us )?(?:the )?(?:floor price|margins?|cost price|purchase price|wholesale price|buying price|
    reserve price|system prompt)|
    what(?:'s| is| are) (?:your|ur|the) (?:actual |real |exact |internal )?(?:floor(?: price)?|margins?|
    cost price|purchase price|wholesale price|buying price|reserve price|system prompt)|
    <\|?(?:im_start|im_end|system|endoftext)\|?>\w*|\[/?inst\]\w*|\[system\]\w*|
    ### ?(?:system|instruction)\w*|
    (?:pichle|pichhle|pichli|pehle ke|purane|saare|sare|sab|sabhi|apne) (?:saare |sare |
    sab )?(?:instructions?|rules|niyam|nirdesh|prompts?|baatein|baaten|baate) (?:ko )?(?:bhool|bhul|ignore|
    chhod|chod)\w*|
    (?:instructions?|rules|niyam|nirdesh|prompts?) (?:ko )?(?:bhool|bhul|ignore|chhod|chod)\w*|
    (?:apne|apna|apni|tumhare|tumhara|aapke|aapka) (?:rules|instructions?|prompts?|niyam|system prompt|
    floor price|margin|cost price) (?:batao|bata do|bataiye|dikhao|bolo|share karo)|
    (?:floor price|cost price|margin|purchase price|asli (?:price|keemat|kimat|daam)) (?:batao|bata do|
    bataiye|bolo|kya hai)|
    (?:पिछले|पिछली|सारे|सभी|सब|अपने) (?:सारे |सभी )?(?:निर्देश\S*|नियम\S*|इंस्ट्रक्शन\S*|
    प्रॉम्प्ट) (?:को )?(?:भूल|अनदेखा|इग्नोर|छोड़)\S*|(?:निर्देश|नियम)\S* (?:को )?(?:भूल|अनदेखा|इग्नोर)\S*|
    (?:अपने|अपना|तुम्हारे|आपके) (?:नियम|निर्देश|प्रॉम्प्ट|सिस्टम प्रॉम्प्ट|लागत मूल्य|मार्जिन|
    फ्लोर प्राइस) (?:बताओ|बताइए|बताइये|दिखाओ)|सिस्टम प्रॉम्प्ट|जेलब्रेक|लागत मूल्य बताओ|
    (?:ignore|disregard|forget|bypass|override|skip) (?:all |any |the |your |of )*(?:pricing|price|discount|
    store|shop|seller|selling|negotiation|company|business) (?:rules|polic(?:y|ies)|limits?|guidelines|
    instructions)|
    as (?:the |your )?(?:store|shop|site|website|system|platform) (?:admin|administrator|owner|manager|
    developer|operator)|
    i (?:hereby )?authori[sz]e (?:a |an |the |this )?(?:\d+ ?% |full |special )?(?:discount|refund|override|
    price)|
    (?:instructions?|prompts?|rules|guidelines) (?:that )?you (?:were |have been |had been )?(?:given|told|
    trained on|programmed with|following|got|received)|
    (?:repeat|print|recite|output|dump|show|display|write out) (?:me |us )?(?:everything|all|the text|
    the words) (?:above|before|so far)|above this (?:line|message|text)|
    (?:e-?mails?|e-?mail address(?:es)?|phone(?: numbers?)?|mobile(?: numbers?)?|contact (?:details|
    numbers?)|address(?:es)?|names) (?:\w+ ){0,3}of (?:your |the |a |an |other |another |previous |last |
    past |recent |any |some )*(?:customers?|buyers?|clients?|users?|shoppers?|people)|
    (?:customers?|buyers?|clients?|users?|shoppers?)'?s? (?!care|service|support|reviews?|ratings?|
    feedback)(?:\w+ ){0,2}(?:e-?mails?|phone|mobile|contact|address(?:es)?|numbers|names|details|data)|
    who (?:bought|ordered|purchased|has bought|has ordered)|
    their (?:names?|address(?:es)?|phone(?: numbers?)?|numbers|e-?mails?|contact details)|
    (?:customers?|buyers?|grahak|kharidar)\w* (?:ka|ki|ke) (?:phone|mobile|number|no|email|address|pata|
    naam|contact|details)|
    (?:ग्राहक|कस्टमर)\S* (?:का|की|के) (?:फोन|नंबर|मोबाइल|ईमेल|पता|नाम)`,
  human_handoff: rx`
    (?:talk|speak|chat|connect|transfer|escalate|put)\w* (?:me )?(?:to|with|through to) (?:a |an |the |
    some |your |real |live |actual |proper )*(?:human|person|people|agent|representative|rep|manager|
    supervisor|someone|somebody|staff|owner|support team|customer (?:care|service|support)|executive|
    operator|team member)|
    (?:want|need) (?:a |an |to talk to a |to speak to a )?(?:real |live |actual )?(?:human|person|manager|
    human agent|live agent)|(?:real|actual|live) (?:human|person|agent)|human please|
    (?:customer care|customer service|helpline) (?:number|no)|call me|call back|callback|
    (?:insaan|insan|aadmi|admi|banda|bande|manager|agent|kisi|owner|malik) se baat|
    baat (?:karao|karwao|karwa do|kara do|karni hai)|
    (?:इंसान|इन्सान|व्यक्ति|आदमी|मैनेजर|एजेंट|किसी|मालिक) से बात|बात (?:कराओ|करवाओ|करवा दो|करा दो|करनी है)`,
  competitor_claim: rx`
    (?:cheaper|less|lower) (?:elsewhere|somewhere else|outside|online|in the market|at another \w+|
    on other \w+|on another \w+)|
    (?:found|seen|saw|got|get|getting|buy|bought) (?:it |this |the same(?: \w+)? )?(?:for |at )?(?:cheaper|
    for less|at a lower price|at less)|
    (?:another|other|different) (?:store|shop|seller|site|website|app|vendor|dukaan)s?|price match\w*|
    (?:dusri|doosri|dusre|doosre|dusra|doosra|baaki|baki|aur) (?:dukaan|dukan|shop|store|jagah|website|
    site)|
    (?:bahar|baahar|market|online|wahan|waha|udhar) (?:pe |par |mein |me )?(?:sasta|saste|sasti|kam (?:mein|
    me|daam|price))|(?:दूसरी|दूसरे|बाकी) (?:दुकान|जगह|वेबसाइट)|(?:बाहर|बाज़ार|ऑनलाइन) (?:में |पर )?सस्त\S*`,
  complaint: rx`
    broken|damaged?|defective|faulty|cracked|torn|leak(?:s|ed|ing)|scratche[sd]|worst|terrible|horrible|
    pathetic|useless|disgusting|awful|rubbish|garbage|fraud\w*|scam\w*|cheat(?:ed|ing|ers?)?|disappoint\w*|
    unacceptable|ridiculous|nonsense|(?:not|isn't|is not|doesn't|does not|didn't|stopped|never) work\w*|
    dead on arrival|wrong (?:item|product|size|colou?r|order|thing)|missing (?:item|part|piece|product)s?|
    never (?:again|buying|ordering|shopping)|waste of (?:money|time)|
    refund (?:now|immediately|asap|right now|today|at once)|complain\w*|angry|furious|fed up|
    consumer (?:court|forum)|idiots?|stupid|wtf|bekaa?r|bakwaa?s|ghatiya|faltu|kharab|dhokh\w*|
    (?:toot|tut) (?:gaya|gayi|gya|gyi)|toota|tooti|tuta|tuti|(?:paisa|paise) (?:barbaa?d|waste|doob\w*)|
    (?:kaam|chal) nahi?n? (?:kar|raha|rha|rahi)\w*|chalu nahi|टूट\S*|खराब|ख़राब|बेकार|घटिया|धोखा\S*|शिकायत|
    बकवास|पैसे बर्बाद|काम नहीं कर\S*`,
  order_status: rx`
    where(?:'s| is| are) my (?:order|package|parcel|delivery|shipment|item|stuff|product)s?|
    track(?! ?(?:pants?|suits?|shoes|lower|jacket|pad))\w*|order status|status of (?:my |the )?order|
    (?:has|did|is) my (?:order|package|parcel)|
    my (?:order|package|parcel|delivery|shipment) (?:status|id|number|no|hasn't|has not|is|was|still|not)|
    when will (?:my |the )(?:order|package|parcel|delivery|item|shipment) (?:arrive|come|be delivered|reach|
    ship)|when will it (?:arrive|be delivered|reach|ship)|
    not (?:yet )?(?:been )?(?:delivered|received|arrived|shipped|dispatched)|(?:shipped|dispatched) yet|awb|
    order (?:id|number|no)|mera (?:order|parcel|package|saman|samaan)|order kab|
    kab (?:tak )?(?:aayega|ayega|aaega|aega|pahunchega|deliver\w*|ship\w*)|(?:order|parcel) kaha\w*|
    (?:मेरा|मेरे) (?:ऑर्डर|आर्डर|पार्सल|सामान)|(?:ऑर्डर|आर्डर|पार्सल) (?:कहां|कब)|
    कब (?:तक )?(?:आएगा|आयेगा|पहुंचेगा)|डिलीवरी कब|ट्रैक\S*`,
  return_request: rx`
    return\w*|send (?:it |this |them )?back|exchange\w*|replace\w*|refund\w*|money back|wapas|vapas|wapis|
    vaapas|lauta\w*|badal(?:na|ni|ke|do|wa\w*|va\w*)?|वापस|लौटा\S*|बदल\S*|रिटर्न|एक्सचेंज|रिफंड`,
  accept: rx`
    i accept|accepted|i agree|agreed|it'?s a deal|deal done|done deal|deal (?:pakk[ai]|final|hai|done)|
    let'?s do (?:it|this)|let'?s go ahead|go ahead|i(?:'ll| will) (?:take|buy) (?:it|this|them)|
    sounds (?:good|great|fair)|works for me|confirm(?:ed)? (?:the |my )?(?:order|deal|it)|
    place (?:the|my) order|ok(?:ay)? (?:done|deal|fine|agreed)|pakk[ai]|th?ee?k hai|thik hai|done hai|
    manzoor|le (?:lunga|lungi|leta|leti)\w*|order (?:kar|place kar) do|chalo (?:th?ee?k|thik|done|deal)\w*|
    ठीक है|पक्का|पक्की|मंजूर|डील (?:पक्की|पक्का|डन)|ले (?:लूंगा|लूंगी|लेता|लेती)\S*|चलो ठीक`,
  ask_price: rx`
    how much|price[sd]?|pricey|pricing|costs?|costing|rates?|mrp|discount\w*|
    (?:best|lowest|last|final) price|any offers?|coupons?|promo ?codes?|cheaper|(?:go|come) (?:any )?lower|
    how expensive|expensive|kitne (?:ka|ki|ke|mein|me|main|rupay\w*|rs|paise)|
    kitna (?:hai|hoga|lagega|padega|price|rate|daam|paisa|paise|dena)|kitni (?:keemat|kimat|price)|
    kya (?:rate|price|daam|dam|keemat|kimat|mrp)|
    (?:rate|price|daam|keemat|kimat|mrp) (?:kya|kitna|kitni|batao|bata\w*)|daam|keemat|kimat|
    (?:thoda|kuch|aur) kam|kam (?:karo|kar do|kijiye|karna)|sast[aei]|कितने (?:का|की|के|में)|
    कितना (?:है|होगा|लगेगा|पड़ेगा)|कीमत|दाम|रेट|प्राइस|मूल्य|डिस्काउंट|छूट|(?:थोड़ा|कुछ) कम|सस्ता`,
  customization: rx`
    engrav\w*|etch\w*|emboss\w*|monogram\w*|personali[sz]\w*|customi[sz]\w*|
    custom (?:name|text|print|design|message|order|made|logo|photo)|
    (?:print|write|put|add) (?:my |a |the |our |his |her |their |your |some )?(?:own )?(?:names?|photo|
    picture|logo|text|initials|message|quote)|
    with (?:my|our|his|her|their|a|custom) (?:name|photo|picture|logo|initials|message|text)|
    (?:naam|name|photo|logo) (?:likh|print|chhap|chap|daal|dal|lagwa)\w*|chhapwa\w*|likhwa\w*|
    (?:नाम|फोटो|लोगो) (?:लिख|छप|प्रिंट|डाल)\S*|छपवा\S*|लिखवा\S*|कस्टम\S*|पर्सनलाइ\S*`,
  availability: rx`
    (?:in|out of|back in) stock|stock|restock\w*|available|availability|sold out|
    do (?:you|u) (?:have|stock|carry|sell)|have (?:it|this|these|any|one) in|can i get (?:it|this|one) in|
    milega|milegi|mil (?:jayega|jaega|jayegi|sakta|sakti)|hai kya|स्टॉक|उपलब्ध|मिलेगा|मिलेगी|
    मिल (?:जाएगा|जायेगा|सकता)`,
  search: rx`
    show (?:me|us|some|any)|looking for|look for|search(?:ing)? for|find (?:me|a|an|some|something)|
    need (?:a|an|some|new|to buy|something)|i need(?! help)|want (?:a|an|some|to buy|something)|
    buy (?:a|an|some)|recommend\w*|suggest\w*|options? for|any good|gift (?:for|ideas?)|
    (?<!help )(?<!madad )chah?i(?:ye|e)|chaiye|dikha\w*|dhoo?n?d\w*|koi (?:achha|accha|acha|badhiya) \w+|
    (?<!मदद )चाहि\S*|दिखा\S*|ढूंढ\S*|सुझा\S*`,
  // "kaisa hai" alone is not a product question: the weather is kaisa too
  product_question: rx`
    does (?:it|this|that|the \w+)|
    is (?:it|this|that|the \w+) (?:\w+ )?(?:made|safe|good|suitable|compatible|original|genuine|waterproof|
    durable|washable)|
    can (?:it|this|i|you) (?:be )?(?:use|wash|microwave|fit|hold|handle|charge|run|support)\w*|
    will (?:it|this) (?:fit|work|support|run|last)|
    what(?:'s| is| are) (?:the |its |it's )?(?:size|sizes|material|dimensions?|weight|capacity|warranty|
    guarantee|colou?rs?|specs?|specifications?|features?|difference|battery|ingredients?|expiry|shelf life|
    delivery time)|how (?:long|big|small|heavy|tall|wide|many|durable|good)|
    which (?:one|size|colou?r|model|variant|is better)|difference between|compare\w*|vs|versus|warrant\w*|
    guarantee\w*|material|made of|dimensions?|weight|compatib\w*|specs?|specifications?|features?|battery|
    capacity|dishwasher|microwave|waterproof|water ?resistant|ingredients?|expiry|shelf life|vegan|organic|
    gluten|calories?|cash on delivery|deliver(?:y)? (?:to|in|time)|kya (?:ye|yeh|isme|ismein|iska|iski)|
    isme\w*|kitna (?:bada|chhota|bhari|time)|kis (?:cheez|chiz|material) (?:ka|ki|se)|
    (?:ye|yeh|iska|iski|quality) (?:\w+ )?kais[ai] hai|quality|क्या (?:यह|ये|इसमें|इसका|इसकी)|इसमें|वारंटी|
    गारंटी|साइज़|क्वालिटी|(?:यह|ये|इसकी|इसका|क्वालिटी) (?:\S+ )?कैस[ाी] है|किस (?:चीज़|मटेरियल)`,
  off_topic: rx`
    weather|forecast|(?:will it|is it going to) rain|mausam|मौसम|politic\w*|elections?|vot(?:e|es|ing)|
    (?:prime|chief) minister|president|government|parliament|chunav|rajneeti|चुनाव|राजनीति|सरकार|
    प्रधानमंत्री|
    (?:write|compose|draft) (?:me |my |a |an |the )*(?:essay|poem|story|song|letter|cover letter|speech|
    article|assignment|homework|code|program|script|function)|essay|homework|assignment|poem|
    tell me a (?:joke|story|riddle)|jokes?|riddle|nibandh|kavita|chutkula|kahani (?:sunao|batao)|निबंध|
    कविता|चुटकुला|कहानी (?:सुनाओ|बताओ)|coding|programming|leetcode|
    (?:python|javascript|typescript|java|c\+\+|sql|html|css|react|node) (?:code|program|script|function|
    error|bug|help|question|tutorial)|debug\w*|(?:fix|write) (?:my |this |the )?(?:code|bug|program|script)|
    who (?:are|made|created|built) you|are you (?:a |an )?(?:bot|robot|ai|human|real)|
    what(?:'s| is) your name|meaning of life|capital of|who (?:won|is the|was the)|what time is it|cricket|
    ipl|football|movies?|netflix|girlfriend|boyfriend|marry me|date me|love you|i'?m bored|translate|
    (?:tum|aap) kaun ho|(?:तुम|आप) कौन (?:हो|हैं)`,
} satisfies Partial<Record<Intent, RegExp>>;

// case-sensitive: "Dan" is a name
export const DAN = new RegExp(String.raw`(?<![${WORD}])DAN(?![${WORD}])`, 'gu');
export const STORES = rx`
  amazon|flipkart|meesho|myntra|ajio|nykaa|croma|snapdeal|jiomart|tata ?cliq|reliance(?: digital)?|
  vijay sales|blinkit|zepto|bigbasket|instamart|shopclues|अमेज़न|अमेज़ॉन|फ्लिपकार्ट|मीशो`;
export const CLAIM = rx`
  cheap\w*|less|lower|sells?|selling|sold|listed|price[sd]?|rates?|costs?|deal|offer\w*|sast[aei]|
  mil (?:raha|rha|rahi|jata|jaata)\w*|milt[ai]|de (?:raha|rha|rahe)|सस्त\S*|मिल रह\S*`;
export const SELLS = rx`
  (?<!you )(?<!u )(?:sells|selling|sold|lists|listed|offers|offering|has|have|had) (?:it|this|that|
  the same(?: \w+)?|same) (?:for|at|in)`;
export const OFFER_STRONG = rx`
  (?:can|could|will|would) (?:you|u) (?:do|make it|give it|sell it|let it go)|do it (?:for|at|in)|make it|
  how about|what about|i(?:'ll| will| can| could| would)? (?:pay|give|offer|do)|
  my (?:final |best |last )?offer|offer\w*|best i can do|(?:would|will|can) (?:you|u) (?:take|accept)|final|
  deal (?:at|for)|settle (?:for|at)|meet (?:me )?(?:at|halfway|in the middle)|(?:come|bring it|go) down to|
  (?:drop|lower|reduce) (?:it )?to|de do|dedo|de dijiye|de dena|kar do|kardo|kar dijiye|laga do|lagao|
  fix (?:kar|karo)\w*|chaleg[ai]|dung[ai]|de sakt[ae]|le lo|(?:zyada|jyada) nahi\w*|दे दो|दे दीजिए|
  दे दीजिये|कर दो|लगा दो|लगाओ|फाइनल|चलेगा|दूंगा|दूंगी|ज़्यादा नहीं`;
export const OFFER_WEAK = rx`
  budget|max(?:imum)?|(?:not|no) more than|only|just|for|at|mein|me|mai|tak|बजट|तक|में`;
/** Asking the seller to come down without naming a price ("thoda aur kam karo"): an offer with no amount. */
export const CONCESSION = rx`
  (?:go|come) (?:a (?:bit|little) |any |some |even )?(?:lower|down)|(?:a bit|a little|any) lower|
  lower (?:it|that|the price|your price)|reduce (?:it|that|the price|your price)|bring (?:it|that|the price) down|
  (?:can|could) you do better|cheaper than that|
  (?:thoda|thodi|thora|kuch|aur|zara|jara) (?:aur |or |sa |si )?kam (?:karo|kar do|kardo|kijiye|kariye|karein|
  karna|ho sakta|hoga|karoge)|kam (?:karo|kar do|kardo|kijiye|kariye|karein|karoge)|
  (?:थोड़ा|कुछ|और|ज़रा) (?:और )?कम (?:करो|कर दो|कीजिए|करिए|करें|हो सकता)|कम (?:करो|कर दो|कीजिए|करिए|करें)`;
export const PRODUCTS = rx`
  mugs?|cups?|bottles?|t-?shirts?|shirts?|tees|kurtas?|kurtis?|sarees?|saris?|dress(?:es)?|jeans|trousers|
  jackets?|hoodies?|shoes|sneakers|sandals|chappals?|slippers|phones?|mobiles?|smartphones?|iphones?|
  laptops?|tablets?|ipads?|headphones|earphones|earbuds|speakers?|chargers?|cables?|
  (?:smart ?)?watch(?:es)?|tvs?|televisions?|monitors?|keyboards?|mouse|gpus?|graphics cards?|cameras?|
  consoles?|chocolates?|sweets|mithai|coffee|tea|snacks?|gifts?|hampers?|bags?|backpacks?|wallets?|books?|
  notebooks?|lamps?|bedsheets?|pillows?|toys?|jewell?ery|perfumes?|rice|atta|ghee|मग|कप|बोतल|शर्ट|कुर्ता|
  साड़ी|जूते|फोन|मोबाइल|लैपटॉप|घड़ी|चॉकलेट|मिठाई|गिफ्ट|उपहार|बैग|किताब`;
export const SMALL_TALK = rx`
  how are (?:you|u)(?: doing)?|how r u|how're you|kaise ho|kaise hain|kya haal(?: hai| hain)?|
  कैसे (?:हो|हैं)|क्या हाल(?: है)?`;

export const GREETINGS = words`
  hi hii hiii hello helo hey heya heyy hlo namaste namastey namaskar namaskaar pranam hola yo sup greetings
  morning afternoon evening salaam salam नमस्ते नमस्कार प्रणाम हेलो हैलो हाय`;
export const GREETING_FILLERS = words`
  good there bhai bhaiya ji jee sir madam maam ma'am team all everyone dear friend friends guys bro buddy जी
  भाई सर`;
export const WEAK_ACCEPT = words`
  ok okay okie okk k kk done deal fine yes yeah yep yup sure haan han haa chalega theek thik accha acha
  achha cool great perfect हाँ हां ठीक अच्छा चलेगा`;
export const ACCEPT_FILLERS = words`
  then bhai bhaiya ji sir madam please pls plz thanks thank you thx chalo let's lets go so very good nice
  hai boss yaar dear जी भाई चलो है धन्यवाद`;
export const TOKENS = new RegExp(`[${W}']+`, 'gu');

export const HINGLISH = rx`
  bhai|bhaiya|bhaiyya|yaar|yar|kya|kyaa|kyu|kyun|kyon|kitna|kitne|kitni|chahiye|chahie|chaiye|hai|hain|nahi|
  nahin|nhi|kar do|kardo|karo|kariye|kijiye|karna|de do|dedo|dena|de dijiye|mein|accha|acha|achha|theek|
  thik|wala|wali|wale|waala|mujhe|mera|meri|mere|humein|hume|hum|tum|tumhara|aap|aapka|aapko|apna|apni|apne|
  yeh|ye|woh|wo|toh|bhi|aur|lekin|magar|kuch|koi|sab|sabse|bahut|bohot|zyada|jyada|kam|thoda|sasta|mehnga|
  mehenga|batao|bataiye|bolo|dikhao|bhejo|milega|chalega|pakka|haan|abhi|aaj|kal|kab|kahan|kaha|kaise|kaisa|
  kaun|matlab|sirf|bas|wapas|vapas|dukaan|dukan|paisa|paise|rupaye|jao|jaao|bhool|bhul|pichle|pichli|pehle|
  hoon|hun|tha|thi|ka|ki|ke|se|ko|liye|lena|lunga|dunga|insaan|baat|ji`;
export const BUDGET = rx`
  budget|under|below|within|upto|up to|less than|max(?:imum)?|(?:not|no) more than|tak|se kam|से कम|तक|बजट`;
export const COMPATIBILITY = rx`
  compatib\w*|works? (?:with|on)|fits? (?:in|on|with|my|into)|supports?|
  for (?:my|a|the) (?:laptop|phone|pc|car|bike|tv|camera|console|ps[45]|xbox|iphone|android|macbook|
  desktop)|(?:mere|mera|meri) \w+ (?:mein|me|pe|par|ke liye) (?:chalega|lagega|fit)\w*|संगत|सपोर्ट\S*`;
export const SPECS = rx`
  \d+(?:\.\d+)? ?(?:gb|tb|mah|w|watts?|hz|ghz|inch(?:es)?|in|mm|cm|kg|g|gm|ml|l|ltr|mp|fps)|ram|ssd|hdd|
  storage|processor|resolution|refresh rate|wireless|bluetooth|waterproof|cotton|silk|steel|ceramic|leather|
  wooden|xxl|xl|size \w+|colou?r \w+`;
export const DEADLINE = rx`
  (?:by|before) (?:tomorrow|today|tonight|\w+day|the weekend|next week|diwali|holi|christmas|eid|rakhi)|
  urgent\w*|asap|within \d+ days?|kal tak|aaj hi|jaldi|जल्दी|कल तक`;
