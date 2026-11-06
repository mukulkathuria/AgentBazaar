"""Intent classification for shopping chat in English, Hindi (Devanagari) and Hinglish.

The default backend ("rules-v1") is deterministic: text is canonicalised (NFKC, casefold, nukta
dropped, chandrabindu -> anusvara, whitespace collapsed), each intent has a table of cue phrases,
and the first intent in priority order with a matching cue wins. The optional Hugging Face backend
replaces only the intent decision; rules still supply entities, language and the injection guard.
"""

import math
import re
import unicodedata
from collections.abc import Callable
from typing import cast

from .schemas import (
    INTENTS,
    MAX_SAFE_INT,
    ClassifyResponse,
    DetectedLanguage,
    Entities,
    Intent,
    LanguageHint,
    Level,
)

RULES_MODEL = "rules-v1"
Classifier = Callable[[str, LanguageHint | None], ClassifyResponse]

_FOLD = str.maketrans({"\u093c": None, "\u0901": "\u0902", "\u2018": "'", "\u2019": "'"})
_W = r"\w\u0900-\u0963\u0966-\u097f"  # word chars incl. Devanagari vowel signs/virama (no dandas)
_B = rf"(?<![{_W}])"
_E = rf"(?![{_W}])"


def _canon(s: str) -> str:
    return unicodedata.normalize("NFKC", s).translate(_FOLD)


def _fold(text: str) -> str:
    return " ".join(_canon(text).casefold().split())


def _rx(*alternatives: str) -> re.Pattern[str]:
    """One whole-word regex over cue alternatives (written in lower case, canonical form)."""
    return re.compile(f"{_B}(?:{'|'.join(_canon(a) for a in alternatives)}){_E}")


def _words(*words: str) -> frozenset[str]:
    return frozenset(_fold(w) for w in words)


def _hits(rx: re.Pattern[str], folded: str) -> int:
    return len({m.group() for m in rx.finditer(folded)})


# --- intent cues -----------------------------------------------------------------------------

_CUES: dict[str, re.Pattern[str]] = {
    "injection_attempt": _rx(
        r"ignore (?:all |any |the |your |my |of |these |those )*(?:previous |prior |above |earlier"
        r" |preceding |past |last |system |initial |original |existing )*(?:instructions?|prompts?"
        r"|rules|directions|guidelines|programming|training)",
        r"disregard (?:all |any |the |your |of )*(?:previous |prior |above |earlier |preceding"
        r" |system )*(?:instructions?|prompts?|rules|directions|guidelines|programming)",
        r"forget (?:all |any |the |your |about )*(?:previous |prior |above |earlier |preceding"
        r" |system )*(?:instructions?|prompts?|rules|guidelines|programming|training)",
        r"(?:override|bypass|disable|turn off) (?:all |any |the |your )*(?:instructions?|rules"
        r"|safety\w*|guardrails?|filters?|restrictions?|limits?)",
        r"system ?prompts?",
        r"system messages?",
        r"(?:initial|hidden|original|secret) (?:prompt|instructions)",
        r"prompt injection",
        r"you(?:'re| are) now (?:a |an |my |the |in |no longer|free|unrestricted|unfiltered"
        r"|jailbroken|going to|dan)",
        r"from now on,? you (?:are|will|must|should)",
        r"act as (?:an? |my |the )?(?:unrestricted|unfiltered|jailbroken|evil|dan|developer|admin"
        r"|root|system)",
        r"(?:developer|dev|god|admin|debug|sudo|unrestricted) mode",
        r"jail ?break\w*",
        r"pretend\w*",
        r"role[ -]?play\w*",
        r"do anything now",
        r"(?:reveal|show|tell|give|share|leak|print|display|expose|disclose|dump|output|repeat)"
        r" (?:me |us )?(?:your|ur|the system'?s?|the hidden|the internal|the secret|internal|hidden"
        r"|secret|system) (?:actual |real |exact |internal |hidden |secret |full |original )*"
        r"(?:rules|instructions|prompt|system prompt|guardrails|floor(?: price)?|margins?"
        r"|cost price|purchase price|wholesale price|buying price|reserve price|base price)",
        r"(?:reveal|show|tell|give|share|leak|print|display|expose|disclose|dump|output)"
        r" (?:me |us )?(?:the )?(?:floor price|margins?|cost price|purchase price|wholesale price"
        r"|buying price|reserve price|system prompt)",
        r"what(?:'s| is| are) (?:your|ur|the) (?:actual |real |exact |internal )?"
        r"(?:floor(?: price)?|margins?|cost price|purchase price|wholesale price|buying price"
        r"|reserve price|system prompt)",
        r"<\|?(?:im_start|im_end|system|endoftext)\|?>\w*",
        r"\[/?inst\]\w*",
        r"\[system\]\w*",
        r"### ?(?:system|instruction)\w*",
        r"(?:pichle|pichhle|pichli|pehle ke|purane|saare|sare|sab|sabhi|apne)"
        r" (?:saare |sare |sab )?(?:instructions?|rules|niyam|nirdesh|prompts?|baatein|baaten"
        r"|baate) (?:ko )?(?:bhool|bhul|ignore|chhod|chod)\w*",
        r"(?:instructions?|rules|niyam|nirdesh|prompts?) (?:ko )?"
        r"(?:bhool|bhul|ignore|chhod|chod)\w*",
        r"(?:apne|apna|apni|tumhare|tumhara|aapke|aapka) (?:rules|instructions?|prompts?|niyam"
        r"|system prompt|floor price|margin|cost price) (?:batao|bata do|bataiye|dikhao|bolo"
        r"|share karo)",
        r"(?:floor price|cost price|margin|purchase price|asli (?:price|keemat|kimat|daam))"
        r" (?:batao|bata do|bataiye|bolo|kya hai)",
        r"(?:पिछले|पिछली|सारे|सभी|सब|अपने) (?:सारे |सभी )?(?:निर्देश\S*|नियम\S*|इंस्ट्रक्शन\S*|प्रॉम्प्ट)"
        r" (?:को )?(?:भूल|अनदेखा|इग्नोर|छोड़)\S*",
        r"(?:निर्देश|नियम)\S* (?:को )?(?:भूल|अनदेखा|इग्नोर)\S*",
        r"(?:अपने|अपना|तुम्हारे|आपके) (?:नियम|निर्देश|प्रॉम्प्ट|सिस्टम प्रॉम्प्ट|लागत मूल्य|मार्जिन"
        r"|फ्लोर प्राइस) (?:बताओ|बताइए|बताइये|दिखाओ)",
        r"सिस्टम प्रॉम्प्ट",
        r"जेलब्रेक",
        r"लागत मूल्य बताओ",
    ),
    "human_handoff": _rx(
        r"(?:talk|speak|chat|connect|transfer|escalate|put)\w* (?:me )?(?:to|with|through to)"
        r" (?:a |an |the |some |your |real |live |actual |proper )*(?:human|person|people|agent"
        r"|representative|rep|manager|supervisor|someone|somebody|staff|owner|support team"
        r"|customer (?:care|service|support)|executive|operator|team member)",
        r"(?:want|need) (?:a |an |to talk to a |to speak to a )?(?:real |live |actual )?"
        r"(?:human|person|manager|human agent|live agent)",
        r"(?:real|actual|live) (?:human|person|agent)",
        r"human please",
        r"(?:customer care|customer service|helpline) (?:number|no)",
        r"call me",
        r"call back",
        r"callback",
        r"(?:insaan|insan|aadmi|admi|banda|bande|manager|agent|kisi|owner|malik) se baat",
        r"baat (?:karao|karwao|karwa do|kara do|karni hai)",
        r"(?:इंसान|इन्सान|व्यक्ति|आदमी|मैनेजर|एजेंट|किसी|मालिक) से बात",
        r"बात (?:कराओ|करवाओ|करवा दो|करा दो|करनी है)",
    ),
    "competitor_claim": _rx(
        r"(?:cheaper|less|lower) (?:elsewhere|somewhere else|outside|online|in the market"
        r"|at another \w+|on other \w+|on another \w+)",
        r"(?:found|seen|saw|got|get|getting|buy|bought) (?:it |this |the same(?: \w+)? )?"
        r"(?:for |at )?(?:cheaper|for less|at a lower price|at less)",
        r"(?:another|other|different) (?:store|shop|seller|site|website|app|vendor|dukaan)s?",
        r"price match\w*",
        r"(?:dusri|doosri|dusre|doosre|dusra|doosra|baaki|baki|aur) (?:dukaan|dukan|shop|store"
        r"|jagah|website|site)",
        r"(?:bahar|baahar|market|online|wahan|waha|udhar) (?:pe |par |mein |me )?(?:sasta|saste"
        r"|sasti|kam (?:mein|me|daam|price))",
        r"(?:दूसरी|दूसरे|बाकी) (?:दुकान|जगह|वेबसाइट)",
        r"(?:बाहर|बाज़ार|ऑनलाइन) (?:में |पर )?सस्त\S*",
    ),
    "complaint": _rx(
        r"broken",
        r"damaged?",
        r"defective",
        r"faulty",
        r"cracked",
        r"torn",
        r"leak(?:s|ed|ing)",
        r"scratche[sd]",
        r"worst",
        r"terrible",
        r"horrible",
        r"pathetic",
        r"useless",
        r"disgusting",
        r"awful",
        r"rubbish",
        r"garbage",
        r"fraud\w*",
        r"scam\w*",
        r"cheat(?:ed|ing|ers?)?",
        r"disappoint\w*",
        r"unacceptable",
        r"ridiculous",
        r"nonsense",
        r"(?:not|isn't|is not|doesn't|does not|didn't|stopped|never) work\w*",
        r"dead on arrival",
        r"wrong (?:item|product|size|colou?r|order|thing)",
        r"missing (?:item|part|piece|product)s?",
        r"never (?:again|buying|ordering|shopping)",
        r"waste of (?:money|time)",
        r"refund (?:now|immediately|asap|right now|today|at once)",
        r"complain\w*",
        r"angry",
        r"furious",
        r"fed up",
        r"consumer (?:court|forum)",
        r"idiots?",
        r"stupid",
        r"wtf",
        r"bekaa?r",
        r"bakwaa?s",
        r"ghatiya",
        r"faltu",
        r"kharab",
        r"dhokh\w*",
        r"(?:toot|tut) (?:gaya|gayi|gya|gyi)",
        r"toota",
        r"tooti",
        r"tuta",
        r"tuti",
        r"(?:paisa|paise) (?:barbaa?d|waste|doob\w*)",
        r"(?:kaam|chal) nahi?n? (?:kar|raha|rha|rahi)\w*",
        r"chalu nahi",
        r"टूट\S*",
        r"खराब",
        r"ख़राब",
        r"बेकार",
        r"घटिया",
        r"धोखा\S*",
        r"शिकायत",
        r"बकवास",
        r"पैसे बर्बाद",
        r"काम नहीं कर\S*",
    ),
    "order_status": _rx(
        r"where(?:'s| is| are) my (?:order|package|parcel|delivery|shipment|item|stuff|product)s?",
        r"track(?! ?(?:pants?|suits?|shoes|lower|jacket|pad))\w*",
        r"order status",
        r"status of (?:my |the )?order",
        r"(?:has|did|is) my (?:order|package|parcel)",
        r"my (?:order|package|parcel|delivery|shipment) (?:status|id|number|no|hasn't|has not|is"
        r"|was|still|not)",
        r"when will (?:my |the )(?:order|package|parcel|delivery|item|shipment) (?:arrive|come"
        r"|be delivered|reach|ship)",
        r"when will it (?:arrive|be delivered|reach|ship)",
        r"not (?:yet )?(?:been )?(?:delivered|received|arrived|shipped|dispatched)",
        r"(?:shipped|dispatched) yet",
        r"awb",
        r"order (?:id|number|no)",
        r"mera (?:order|parcel|package|saman|samaan)",
        r"order kab",
        r"kab (?:tak )?(?:aayega|ayega|aaega|aega|pahunchega|deliver\w*|ship\w*)",
        r"(?:order|parcel) kaha\w*",
        r"(?:मेरा|मेरे) (?:ऑर्डर|आर्डर|पार्सल|सामान)",
        r"(?:ऑर्डर|आर्डर|पार्सल) (?:कहां|कब)",
        r"कब (?:तक )?(?:आएगा|आयेगा|पहुंचेगा)",
        r"डिलीवरी कब",
        r"ट्रैक\S*",
    ),
    "return_request": _rx(
        r"return\w*",
        r"send (?:it |this |them )?back",
        r"exchange\w*",
        r"replace\w*",
        r"refund\w*",
        r"money back",
        r"wapas",
        r"vapas",
        r"wapis",
        r"vaapas",
        r"lauta\w*",
        r"badal(?:na|ni|ke|do|wa\w*|va\w*)?",
        r"वापस",
        r"लौटा\S*",
        r"बदल\S*",
        r"रिटर्न",
        r"एक्सचेंज",
        r"रिफंड",
    ),
    "accept": _rx(
        r"i accept",
        r"accepted",
        r"i agree",
        r"agreed",
        r"it'?s a deal",
        r"deal done",
        r"done deal",
        r"deal (?:pakk[ai]|final|hai|done)",
        r"let'?s do (?:it|this)",
        r"let'?s go ahead",
        r"go ahead",
        r"i(?:'ll| will) (?:take|buy) (?:it|this|them)",
        r"sounds (?:good|great|fair)",
        r"works for me",
        r"confirm(?:ed)? (?:the |my )?(?:order|deal|it)",
        r"place (?:the|my) order",
        r"ok(?:ay)? (?:done|deal|fine|agreed)",
        r"pakk[ai]",
        r"th?ee?k hai",
        r"thik hai",
        r"done hai",
        r"manzoor",
        r"le (?:lunga|lungi|leta|leti)\w*",
        r"order (?:kar|place kar) do",
        r"chalo (?:th?ee?k|thik|done|deal)\w*",
        r"ठीक है",
        r"पक्का",
        r"पक्की",
        r"मंजूर",
        r"डील (?:पक्की|पक्का|डन)",
        r"ले (?:लूंगा|लूंगी|लेता|लेती)\S*",
        r"चलो ठीक",
    ),
    "ask_price": _rx(
        r"how much",
        r"price[sd]?",
        r"pricey",
        r"pricing",
        r"costs?",
        r"costing",
        r"rates?",
        r"mrp",
        r"discount\w*",
        r"(?:best|lowest|last|final) price",
        r"any offers?",
        r"coupons?",
        r"promo ?codes?",
        r"cheaper",
        r"(?:go|come) (?:any )?lower",
        r"how expensive",
        r"expensive",
        r"kitne (?:ka|ki|ke|mein|me|main|rupay\w*|rs|paise)",
        r"kitna (?:hai|hoga|lagega|padega|price|rate|daam|paisa|paise|dena)",
        r"kitni (?:keemat|kimat|price)",
        r"kya (?:rate|price|daam|dam|keemat|kimat|mrp)",
        r"(?:rate|price|daam|keemat|kimat|mrp) (?:kya|kitna|kitni|batao|bata\w*)",
        r"daam",
        r"keemat",
        r"kimat",
        r"(?:thoda|kuch|aur) kam",
        r"kam (?:karo|kar do|kijiye|karna)",
        r"sast[aei]",
        r"कितने (?:का|की|के|में)",
        r"कितना (?:है|होगा|लगेगा|पड़ेगा)",
        r"कीमत",
        r"दाम",
        r"रेट",
        r"प्राइस",
        r"मूल्य",
        r"डिस्काउंट",
        r"छूट",
        r"(?:थोड़ा|कुछ) कम",
        r"सस्ता",
    ),
    "customization": _rx(
        r"engrav\w*",
        r"etch\w*",
        r"emboss\w*",
        r"monogram\w*",
        r"personali[sz]\w*",
        r"customi[sz]\w*",
        r"custom (?:name|text|print|design|message|order|made|logo|photo)",
        r"(?:print|write|put|add) (?:my |a |the |our |his |her |their |your |some )?(?:own )?"
        r"(?:names?|photo|picture|logo|text|initials|message|quote)",
        r"with (?:my|our|his|her|their|a|custom) (?:name|photo|picture|logo|initials|message|text)",
        r"(?:naam|name|photo|logo) (?:likh|print|chhap|chap|daal|dal|lagwa)\w*",
        r"chhapwa\w*",
        r"likhwa\w*",
        r"(?:नाम|फोटो|लोगो) (?:लिख|छप|प्रिंट|डाल)\S*",
        r"छपवा\S*",
        r"लिखवा\S*",
        r"कस्टम\S*",
        r"पर्सनलाइ\S*",
    ),
    "availability": _rx(
        r"(?:in|out of|back in) stock",
        r"stock",
        r"restock\w*",
        r"available",
        r"availability",
        r"sold out",
        r"do (?:you|u) (?:have|stock|carry|sell)",
        r"have (?:it|this|these|any|one) in",
        r"can i get (?:it|this|one) in",
        r"milega",
        r"milegi",
        r"mil (?:jayega|jaega|jayegi|sakta|sakti)",
        r"hai kya",
        r"स्टॉक",
        r"उपलब्ध",
        r"मिलेगा",
        r"मिलेगी",
        r"मिल (?:जाएगा|जायेगा|सकता)",
    ),
    "search": _rx(
        r"show (?:me|us|some|any)",
        r"looking for",
        r"look for",
        r"search(?:ing)? for",
        r"find (?:me|a|an|some|something)",
        r"need (?:a|an|some|new|to buy|something)",
        r"i need(?! help)",
        r"want (?:a|an|some|to buy|something)",
        r"buy (?:a|an|some)",
        r"recommend\w*",
        r"suggest\w*",
        r"options? for",
        r"any good",
        r"gift (?:for|ideas?)",
        r"(?<!help )(?<!madad )chah?i(?:ye|e)",
        r"chaiye",
        r"dikha\w*",
        r"dhoo?n?d\w*",
        r"koi (?:achha|accha|acha|badhiya) \w+",
        r"(?<!मदद )चाहि\S*",
        r"दिखा\S*",
        r"ढूंढ\S*",
        r"सुझा\S*",
    ),
    "product_question": _rx(
        r"does (?:it|this|that|the \w+)",
        r"is (?:it|this|that|the \w+) (?:\w+ )?(?:made|safe|good|suitable|compatible|original"
        r"|genuine|waterproof|durable|washable)",
        r"can (?:it|this|i|you) (?:be )?"
        r"(?:use|wash|microwave|fit|hold|handle|charge|run|support)\w*",
        r"will (?:it|this) (?:fit|work|support|run|last)",
        r"what(?:'s| is| are) (?:the |its |it's )?(?:size|sizes|material|dimensions?|weight"
        r"|capacity|warranty|guarantee|colou?rs?|specs?|specifications?|features?|difference"
        r"|battery|ingredients?|expiry|shelf life|delivery time)",
        r"how (?:long|big|small|heavy|tall|wide|many|durable|good)",
        r"which (?:one|size|colou?r|model|variant|is better)",
        r"difference between",
        r"compare\w*",
        r"vs",
        r"versus",
        r"warrant\w*",
        r"guarantee\w*",
        r"material",
        r"made of",
        r"dimensions?",
        r"weight",
        r"compatib\w*",
        r"specs?",
        r"specifications?",
        r"features?",
        r"battery",
        r"capacity",
        r"dishwasher",
        r"microwave",
        r"waterproof",
        r"water ?resistant",
        r"ingredients?",
        r"expiry",
        r"shelf life",
        r"vegan",
        r"organic",
        r"gluten",
        r"calories?",
        r"cash on delivery",
        r"deliver(?:y)? (?:to|in|time)",
        r"kya (?:ye|yeh|isme|ismein|iska|iski)",
        r"isme\w*",
        r"kitna (?:bada|chhota|bhari|time)",
        r"kis (?:cheez|chiz|material) (?:ka|ki|se)",
        r"(?:ye|yeh|iska|iski|quality) (?:\w+ )?kais[ai] hai",  # not bare "kaisa hai": weather too
        r"quality",
        r"क्या (?:यह|ये|इसमें|इसका|इसकी)",
        r"इसमें",
        r"वारंटी",
        r"गारंटी",
        r"साइज़",
        r"क्वालिटी",
        r"(?:यह|ये|इसकी|इसका|क्वालिटी) (?:\S+ )?कैस[ाी] है",
        r"किस (?:चीज़|मटेरियल)",
    ),
    "off_topic": _rx(
        r"weather",
        r"forecast",
        r"(?:will it|is it going to) rain",
        r"mausam",
        r"मौसम",
        r"politic\w*",
        r"elections?",
        r"vot(?:e|es|ing)",
        r"(?:prime|chief) minister",
        r"president",
        r"government",
        r"parliament",
        r"chunav",
        r"rajneeti",
        r"चुनाव",
        r"राजनीति",
        r"सरकार",
        r"प्रधानमंत्री",
        r"(?:write|compose|draft) (?:me |my |a |an |the )*(?:essay|poem|story|song|letter"
        r"|cover letter|speech|article|assignment|homework|code|program|script|function)",
        r"essay",
        r"homework",
        r"assignment",
        r"poem",
        r"tell me a (?:joke|story|riddle)",
        r"jokes?",
        r"riddle",
        r"nibandh",
        r"kavita",
        r"chutkula",
        r"kahani (?:sunao|batao)",
        r"निबंध",
        r"कविता",
        r"चुटकुला",
        r"कहानी (?:सुनाओ|बताओ)",
        r"coding",
        r"programming",
        r"leetcode",
        r"(?:python|javascript|typescript|java|c\+\+|sql|html|css|react|node) (?:code|program"
        r"|script|function|error|bug|help|question|tutorial)",
        r"debug\w*",
        r"(?:fix|write) (?:my |this |the )?(?:code|bug|program|script)",
        r"who (?:are|made|created|built) you",
        r"are you (?:a |an )?(?:bot|robot|ai|human|real)",
        r"what(?:'s| is) your name",
        r"meaning of life",
        r"capital of",
        r"who (?:won|is the|was the)",
        r"what time is it",
        r"cricket",
        r"ipl",
        r"football",
        r"movies?",
        r"netflix",
        r"girlfriend",
        r"boyfriend",
        r"marry me",
        r"date me",
        r"love you",
        r"i'?m bored",
        r"translate",
        r"(?:tum|aap) kaun ho",
        r"(?:तुम|आप) कौन (?:हो|हैं)",
    ),
}

# Priority order: safety first, then post-purchase, negotiation, then discovery.
_ORDER: tuple[Intent, ...] = (
    "injection_attempt",
    "human_handoff",
    "competitor_claim",
    "complaint",
    "order_status",
    "return_request",
    "make_offer",
    "accept",
    "ask_price",
    "customization",
    "availability",
    "search",
    "product_question",
    "off_topic",
    "greeting",
)
_BASE_CONFIDENCE: dict[str, float] = {
    "injection_attempt": 0.8,
    "human_handoff": 0.8,
    "competitor_claim": 0.75,
    "complaint": 0.7,
    "order_status": 0.75,
    "return_request": 0.7,
    "make_offer": 0.7,
    "accept": 0.7,
    "ask_price": 0.75,
    "customization": 0.75,
    "availability": 0.7,
    "search": 0.65,
    "product_question": 0.6,
    "off_topic": 0.65,
    "greeting": 0.9,
}

_DAN = re.compile(r"\bDAN\b")  # case-sensitive: "Dan" is a name
_STORES = _rx(
    r"amazon",
    r"flipkart",
    r"meesho",
    r"myntra",
    r"ajio",
    r"nykaa",
    r"croma",
    r"snapdeal",
    r"jiomart",
    r"tata ?cliq",
    r"reliance(?: digital)?",
    r"vijay sales",
    r"blinkit",
    r"zepto",
    r"bigbasket",
    r"instamart",
    r"shopclues",
    r"अमेज़न",
    r"अमेज़ॉन",
    r"फ्लिपकार्ट",
    r"मीशो",
)
_CLAIM = _rx(
    r"cheap\w*",
    r"less",
    r"lower",
    r"sells?",
    r"selling",
    r"sold",
    r"listed",
    r"price[sd]?",
    r"rates?",
    r"costs?",
    r"deal",
    r"offer\w*",
    r"sast[aei]",
    r"mil (?:raha|rha|rahi|jata|jaata)\w*",
    r"milt[ai]",
    r"de (?:raha|rha|rahe)",
    r"सस्त\S*",
    r"मिल रह\S*",
)
_SELLS = _rx(
    r"(?<!you )(?<!u )(?:sells|selling|sold|lists|listed|offers|offering|has|have|had)"
    r" (?:it|this|that|the same(?: \w+)?|same) (?:for|at|in)"
)
_OFFER_STRONG = _rx(
    r"(?:can|could|will|would) (?:you|u) (?:do|make it|give it|sell it|let it go)",
    r"do it (?:for|at|in)",
    r"make it",
    r"how about",
    r"what about",
    r"i(?:'ll| will| can| could| would)? (?:pay|give|offer|do)",
    r"my (?:final |best |last )?offer",
    r"offer\w*",
    r"best i can do",
    r"(?:would|will|can) (?:you|u) (?:take|accept)",
    r"final",
    r"deal (?:at|for)",
    r"settle (?:for|at)",
    r"meet (?:me )?(?:at|halfway|in the middle)",
    r"(?:come|bring it|go) down to",
    r"(?:drop|lower|reduce) (?:it )?to",
    r"de do",
    r"dedo",
    r"de dijiye",
    r"de dena",
    r"kar do",
    r"kardo",
    r"kar dijiye",
    r"laga do",
    r"lagao",
    r"fix (?:kar|karo)\w*",
    r"chaleg[ai]",
    r"dung[ai]",
    r"de sakt[ae]",
    r"le lo",
    r"(?:zyada|jyada) nahi\w*",
    r"दे दो",
    r"दे दीजिए",
    r"दे दीजिये",
    r"कर दो",
    r"लगा दो",
    r"लगाओ",
    r"फाइनल",
    r"चलेगा",
    r"दूंगा",
    r"दूंगी",
    r"ज़्यादा नहीं",
)
_OFFER_WEAK = _rx(
    r"budget",
    r"max(?:imum)?",
    r"(?:not|no) more than",
    r"only",
    r"just",
    r"for",
    r"at",
    r"mein",
    r"me",
    r"mai",
    r"tak",
    r"बजट",
    r"तक",
    r"में",
)
_PRODUCTS = _rx(
    r"mugs?",
    r"cups?",
    r"bottles?",
    r"t-?shirts?",
    r"shirts?",
    r"tees",
    r"kurtas?",
    r"kurtis?",
    r"sarees?",
    r"saris?",
    r"dress(?:es)?",
    r"jeans",
    r"trousers",
    r"jackets?",
    r"hoodies?",
    r"shoes",
    r"sneakers",
    r"sandals",
    r"chappals?",
    r"slippers",
    r"phones?",
    r"mobiles?",
    r"smartphones?",
    r"iphones?",
    r"laptops?",
    r"tablets?",
    r"ipads?",
    r"headphones",
    r"earphones",
    r"earbuds",
    r"speakers?",
    r"chargers?",
    r"cables?",
    r"(?:smart ?)?watch(?:es)?",
    r"tvs?",
    r"televisions?",
    r"monitors?",
    r"keyboards?",
    r"mouse",
    r"gpus?",
    r"graphics cards?",
    r"cameras?",
    r"consoles?",
    r"chocolates?",
    r"sweets",
    r"mithai",
    r"coffee",
    r"tea",
    r"snacks?",
    r"gifts?",
    r"hampers?",
    r"bags?",
    r"backpacks?",
    r"wallets?",
    r"books?",
    r"notebooks?",
    r"lamps?",
    r"bedsheets?",
    r"pillows?",
    r"toys?",
    r"jewell?ery",
    r"perfumes?",
    r"rice",
    r"atta",
    r"ghee",
    r"मग",
    r"कप",
    r"बोतल",
    r"शर्ट",
    r"कुर्ता",
    r"साड़ी",
    r"जूते",
    r"फोन",
    r"मोबाइल",
    r"लैपटॉप",
    r"घड़ी",
    r"चॉकलेट",
    r"मिठाई",
    r"गिफ्ट",
    r"उपहार",
    r"बैग",
    r"किताब",
)
_SMALL_TALK = _rx(
    r"how are (?:you|u)(?: doing)?",
    r"how r u",
    r"how're you",
    r"kaise ho",
    r"kaise hain",
    r"kya haal(?: hai| hain)?",
    r"कैसे (?:हो|हैं)",
    r"क्या हाल(?: है)?",
)
_GREETINGS = _words(
    "hi", "hii", "hiii", "hello", "helo", "hey", "heya", "heyy", "hlo", "namaste", "namastey",
    "namaskar", "namaskaar", "pranam", "hola", "yo", "sup", "greetings", "morning", "afternoon",
    "evening", "salaam", "salam", "नमस्ते", "नमस्कार", "प्रणाम", "हेलो", "हैलो", "हाय",
)  # fmt: skip
_GREETING_FILLERS = _words(
    "good", "there", "bhai", "bhaiya", "ji", "jee", "sir", "madam", "maam", "ma'am", "team", "all",
    "everyone", "dear", "friend", "friends", "guys", "bro", "buddy", "जी", "भाई", "सर",
)  # fmt: skip
_WEAK_ACCEPT = _words(
    "ok", "okay", "okie", "okk", "k", "kk", "done", "deal", "fine", "yes", "yeah", "yep", "yup",
    "sure", "haan", "han", "haa", "chalega", "theek", "thik", "accha", "acha", "achha", "cool",
    "great", "perfect", "हाँ", "हां", "ठीक", "अच्छा", "चलेगा",
)  # fmt: skip
_ACCEPT_FILLERS = _words(
    "then", "bhai", "bhaiya", "ji", "sir", "madam", "please", "pls", "plz", "thanks", "thank",
    "you", "thx", "chalo", "let's", "lets", "go", "so", "very", "good", "nice", "hai", "boss",
    "yaar", "dear", "जी", "भाई", "चलो", "है", "धन्यवाद",
)  # fmt: skip
_TOKENS = re.compile(rf"[{_W}']+")

# --- entities --------------------------------------------------------------------------------

_DIGITS = r"(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?(?!\d)"  # Indian and western digit grouping
_NUM = rf"(?<![\d.,]){_DIGITS}"  # never starts mid-number
_MULT = r"(?:k|thousand|hazaa?r|हज़ार|lakhs?|lacs?|लाख|crores?|cr|करोड़)"
_MULTIPLIERS = {
    **dict.fromkeys(("k", "thousand", "hazar", "hazaar", _canon("हज़ार")), 1e3),
    **dict.fromkeys(("lakh", "lakhs", "lac", "lacs", "लाख"), 1e5),
    **dict.fromkeys(("crore", "crores", "cr", _canon("करोड़")), 1e7),
}
_CUR_PRE = r"(?:₹|(?<![a-z])(?:rs\.?|inr|rupees?)|रु\.?|रुपये|रुपए)"
_CUR_POST = r"(?:₹|(?:rs|inr|rupees?|rupaye|rupay|rupiya|rupaiya)(?![a-z])\.?|/-|रुपये|रुपए|रुपया|रु)"
_UNIT = (
    r"\s?(?:%|gb|tb|mb|kb|mah|w|watts?|v|hz|ghz|mhz|inch(?:es)?|in|\"|ft|mm|cm|m|km|kg|g|gms?"
    r"|grams?|mg|ml|l|ltr|litres?|liters?|mp|p|fps|x|am|pm|th|st|nd|rd|yrs?|years?|months?"
    r"|days?|hours?|hrs?|mins?|minutes?|weeks?|people|persons?|pax|seater|units?|pcs?|pieces?"
    r"|nos|items?|packs?|packets?|boxes|bottles|sets?|pairs?|पीस|नग)(?!\w)"
)
_SCREEN = (
    r"(?!\s?(?:tvs?|monitors?|display|video|resolution|uhd|hdr|screen|camera|oled|qled|led)\b)"
)
_AMOUNT_PATTERNS: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = (
    (
        "currency",
        (
            re.compile(_canon(rf"{_CUR_PRE}\s?(?P<n>{_DIGITS})(?:\s?(?P<m>{_MULT})(?!\w))?")),
            re.compile(_canon(rf"(?P<n>{_NUM})(?:\s?(?P<m>{_MULT}))?\s?{_CUR_POST}")),
        ),
    ),
    ("multiplier", (re.compile(_canon(rf"(?P<n>{_NUM})\s?(?P<m>{_MULT})(?!\w){_SCREEN}")),)),
    (
        "cue",
        (
            re.compile(
                _canon(
                    rf"{_B}(?:can you do|could you do|would you do|will you do|do|for|at"
                    rf"|offer(?:ing)?|pay|give|take|budget(?: is| of)?|how about|what about"
                    rf"|max(?:imum)?|under|below|upto|up to|within|around|only|just|final|make it"
                    rf"|settle (?:for|at)):?\s(?P<n>{_NUM})(?!{_UNIT})(?!\s?{_MULT}(?!\w))"
                )
            ),
            re.compile(
                _canon(
                    rf"(?P<n>{_NUM})(?!{_UNIT})\s(?:mein|me|mai|main|tak|final|chalega|chalegi"
                    rf"|dunga|dungi|de do|dedo|kar do|lagao|max|only|fixed|ok|ka|ki|ke|में|तक"
                    rf"|फाइनल|चलेगा|दूंगा|का|की|के){_E}"
                )
            ),
        ),
    ),
)
_BARE_AMOUNT = re.compile(
    _canon(rf"{_CUR_PRE}?\s?(?P<n>{_DIGITS})(?:\s?(?P<m>{_MULT}))?\s?{_CUR_POST}?\s?[?!.]*")
)
_QUANTITY = (
    re.compile(
        _canon(
            r"(?<![\d.,])(?P<n>\d+)\s?(?:units?|pcs?|pieces?|nos|packs?|packets?|boxes|bottles"
            r"|sets?|pairs?|पीस|नग)(?!\w)"
        )
    ),
    re.compile(r"(?<!\w)(?:qty|quantity|qnty)\s?[:=#-]?\s?(?P<n>\d+)(?!\d)"),
    re.compile(
        r"(?<![\w.])[x\u00d7]\s?(?P<n>\d+)(?![\d.])(?!\s?[x\u00d7*])(?!\s?(?:cm|mm|in|inch|inches|ft|m)\b)"
    ),
)


def _value(m: re.Match[str]) -> float | None:
    value = float(m["n"].replace(",", "")) * _MULTIPLIERS.get(m.groupdict().get("m") or "", 1.0)
    return round(value, 2) if math.isfinite(value) else None


def _amount(folded: str) -> tuple[float | None, str]:
    """First amount of the strongest kind: currency-marked > k/lakh/crore > after an offer cue."""
    bare = _BARE_AMOUNT.fullmatch(folded)  # a message that is only an amount reads as an offer
    if bare and (value := _value(bare)) is not None and value >= 10:
        return value, "bare"
    for kind, patterns in _AMOUNT_PATTERNS:
        found = sorted(
            (m.start(), value)
            for rx in patterns
            for m in rx.finditer(folded)
            if (value := _value(m)) is not None and (kind != "cue" or value >= 10)
        )
        if found:
            return found[0][1], kind
    return None, ""


def _quantity(folded: str) -> int | None:
    found = sorted((m.start(), m["n"]) for rx in _QUANTITY for m in rx.finditer(folded))
    for _, digits in found:
        if len(digits) <= 16 and int(digits) <= MAX_SAFE_INT:
            return int(digits)
    return None


def extract_entities(text: str) -> Entities:
    folded = _fold(text)
    return Entities(amount_inr=_amount(folded)[0], quantity=_quantity(folded))


# --- language, complexity, risk --------------------------------------------------------------

_HINGLISH = _rx(
    "bhai", "bhaiya", "bhaiyya", "yaar", "yar", "kya", "kyaa", "kyu", "kyun", "kyon", "kitna",
    "kitne", "kitni", "chahiye", "chahie", "chaiye", "hai", "hain", "nahi", "nahin", "nhi",
    "kar do", "kardo", "karo", "kariye", "kijiye", "karna", "de do", "dedo", "dena", "de dijiye",
    "mein", "accha", "acha", "achha", "theek", "thik", "wala", "wali", "wale", "waala", "mujhe",
    "mera", "meri", "mere", "humein", "hume", "hum", "tum", "tumhara", "aap", "aapka", "aapko",
    "apna", "apni", "apne", "yeh", "ye", "woh", "wo", "toh", "bhi", "aur", "lekin", "magar",
    "kuch", "koi", "sab", "sabse", "bahut", "bohot", "zyada", "jyada", "kam", "thoda", "sasta",
    "mehnga", "mehenga", "batao", "bataiye", "bolo", "dikhao", "bhejo", "milega", "chalega",
    "pakka", "haan", "abhi", "aaj", "kal", "kab", "kahan", "kaha", "kaise", "kaisa", "kaun",
    "matlab", "sirf", "bas", "wapas", "vapas", "dukaan", "dukan", "paisa", "paise", "rupaye",
    "jao", "jaao", "bhool", "bhul", "pichle", "pichli", "pehle", "hoon", "hun", "tha", "thi",
    "ka", "ki", "ke", "se", "ko", "liye", "lena", "lunga", "dunga", "insaan", "baat", "ji",
)  # fmt: skip
_BUDGET = _rx(
    r"budget", r"under", r"below", r"within", r"upto", r"up to", r"less than", r"max(?:imum)?",
    r"(?:not|no) more than", r"tak", r"se kam", r"से कम", r"तक", r"बजट",
)  # fmt: skip
_COMPATIBILITY = _rx(
    r"compatib\w*",
    r"works? (?:with|on)",
    r"fits? (?:in|on|with|my|into)",
    r"supports?",
    r"for (?:my|a|the) (?:laptop|phone|pc|car|bike|tv|camera|console|ps[45]|xbox|iphone|android"
    r"|macbook|desktop)",
    r"(?:mere|mera|meri) \w+ (?:mein|me|pe|par|ke liye) (?:chalega|lagega|fit)\w*",
    r"संगत",
    r"सपोर्ट\S*",
)
_SPECS = _rx(
    r"\d+(?:\.\d+)? ?(?:gb|tb|mah|w|watts?|hz|ghz|inch(?:es)?|in|mm|cm|kg|g|gm|ml|l|ltr|mp|fps)",
    r"ram", r"ssd", r"hdd", r"storage", r"processor", r"resolution", r"refresh rate",
    r"wireless", r"bluetooth", r"waterproof", r"cotton", r"silk", r"steel", r"ceramic",
    r"leather", r"wooden", r"xxl", r"xl", r"size \w+", r"colou?r \w+",
)  # fmt: skip
_DEADLINE = _rx(
    r"(?:by|before) (?:tomorrow|today|tonight|\w+day|the weekend|next week|diwali|holi|christmas"
    r"|eid|rakhi)",
    r"urgent\w*", r"asap", r"within \d+ days?", r"kal tak", r"aaj hi", r"jaldi", r"जल्दी", r"कल तक",
)  # fmt: skip


def detect_language(text: str, hint: LanguageHint | None = None) -> DetectedLanguage:
    deva = latin = other = 0
    for ch in unicodedata.normalize("NFKC", text):
        if not ch.isalpha():
            continue
        cp = ord(ch)
        if 0x0900 <= cp <= 0x097F or 0xA8E0 <= cp <= 0xA8FF:
            deva += 1
        elif cp < 0x0250 or 0x1E00 <= cp <= 0x1EFF:
            latin += 1
        else:
            other += 1
    if not deva + latin + other:
        return hint or "en"
    if deva >= latin and deva >= other:
        return "hi"
    if other > latin:
        return "other"
    markers = len(_HINGLISH.findall(_fold(text)))
    return "hinglish" if markers >= (1 if hint == "hi" else 2) else "en"


def _complexity(folded: str, amount: float | None, quantity: int | None) -> Level:
    constraints = sum(
        (
            amount is not None or bool(_BUDGET.search(folded)),
            bool(_COMPATIBILITY.search(folded)),
            bool(_SPECS.search(folded)),
            quantity is not None,
            bool(_DEADLINE.search(folded)),
            bool(_CUES["customization"].search(folded)),
        )
    )
    words = len(folded.split())
    if constraints >= 3 or words > 60:
        return "high"
    if constraints == 2 or words > 20:
        return "medium"
    return "low"


def risk_for(intent: str, amount: float | None) -> Level:
    if intent == "injection_attempt":
        return "high"
    if intent == "complaint" or (amount or 0) > 100_000:
        return "medium"
    return "low"


# --- decision --------------------------------------------------------------------------------


def _only(words: list[str], core: frozenset[str], fillers: frozenset[str]) -> bool:
    return any(w in core for w in words) and all(w in core or w in fillers for w in words)


def _shouting(text: str) -> bool:
    letters = [c for c in text if c.isascii() and c.isalpha()]
    return len(letters) >= 12 and sum(c.isupper() for c in letters) >= 0.7 * len(letters)


def _intent(folded: str, text: str, amount: float | None, amount_kind: str) -> tuple[Intent, float]:
    hits = {intent: _hits(rx, folded) for intent, rx in _CUES.items()}
    hits["injection_attempt"] += len(_DAN.findall(_canon(text)))
    hits["complaint"] += _shouting(text)

    stores = _hits(_STORES, folded)
    if stores and (amount is not None or _CLAIM.search(folded)):
        hits["competitor_claim"] += stores
    if amount is not None and _SELLS.search(folded):
        hits["competitor_claim"] += 1

    # An offer needs an amount. Weak cues ("for", "budget") only count outside product searches.
    shopping = hits["search"] or _PRODUCTS.search(folded)
    offer = _hits(_OFFER_STRONG, folded) + (0 if shopping else _hits(_OFFER_WEAK, folded))
    hits["make_offer"] = offer + (amount_kind == "bare") if amount is not None else 0

    words = _TOKENS.findall(folded)
    weak_accept = False
    if "?" in folded:
        hits["accept"] = 0  # "ok done?" asks; it does not accept
    elif not hits["accept"] and _only(words, _WEAK_ACCEPT, _ACCEPT_FILLERS):
        hits["accept"], weak_accept = 1, True

    small_talk = bool(_SMALL_TALK.search(folded))
    rest = _TOKENS.findall(_SMALL_TALK.sub(" ", folded))
    hits["greeting"] = int(
        all(w in _GREETINGS or w in _GREETING_FILLERS for w in rest)
        and (small_talk or any(w in _GREETINGS for w in rest))
    )

    matched = [intent for intent in _ORDER if hits[intent]]
    if not matched:
        return ("search", 0.45) if _PRODUCTS.search(folded) else ("unknown", 0.2)
    intent = matched[0]
    weak = weak_accept if intent == "accept" else intent == "make_offer" and not offer
    base = 0.55 if weak else _BASE_CONFIDENCE[intent]
    confidence = base + 0.08 * min(hits[intent] - 1, 3) - 0.07 * (len(matched) - 1)
    return intent, round(min(0.97, max(0.35, confidence)), 3)


def classify_rules(text: str, language_hint: LanguageHint | None = None) -> ClassifyResponse:
    folded = _fold(text)
    amount, amount_kind = _amount(folded)
    quantity = _quantity(folded)
    intent, confidence = _intent(folded, text, amount, amount_kind)
    return ClassifyResponse(
        intent=intent,
        complexity=_complexity(folded, amount, quantity),
        risk=risk_for(intent, amount),
        language=detect_language(text, language_hint),
        confidence=confidence,
        entities=Entities(amount_inr=amount, quantity=quantity),
        model=RULES_MODEL,
    )


class HFClassifier:
    """Optional ``ml`` extra: a text-classification checkpoint whose labels are intent names."""

    def __init__(self, model_id: str, device: str = "cpu") -> None:
        if not model_id:
            raise ValueError("CLASSIFIER_MODEL is required when CLASSIFIER_BACKEND=hf")
        from transformers import pipeline

        self._pipe = pipeline("text-classification", model=model_id, device=device)
        self.model = model_id

    def __call__(self, text: str, language_hint: LanguageHint | None = None) -> ClassifyResponse:
        result = classify_rules(text, language_hint)
        if result.intent == "injection_attempt" or not text.strip():
            return result  # a model never overrides the injection guard
        top = self._pipe(text, truncation=True)[0]
        label = str(top["label"]).strip().lower()
        if label not in INTENTS:
            return result
        intent = cast(Intent, label)
        return result.model_copy(
            update={
                "intent": intent,
                "confidence": round(min(1.0, max(0.0, float(top["score"]))), 3),
                "risk": risk_for(intent, result.entities.amount_inr),
                "model": self.model,
            }
        )
