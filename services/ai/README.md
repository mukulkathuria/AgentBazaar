# AgentBazaar AI service

An optional Python microservice that the TypeScript core API calls over internal HTTP for intent
classification, text embeddings and PII redaction. The core never needs it: it has rules-based
fallbacks for all three. This service is the upgrade path, and its defaults need **no API keys and
no model downloads**.

Wire contracts are generated from the Zod schemas in `packages/contracts/src/ai.ts` into
`packages/contracts/generated/ai/*.json`; the Pydantic models in `src/agentbazaar_ai/schemas.py`
mirror them and `tests/test_contracts.py` enforces it.

## Endpoints

| Method | Path           | Body → Response                     | Notes                                       |
| ------ | -------------- | ----------------------------------- | ------------------------------------------- |
| GET    | `/healthz`     | → `{"status": "ok"}`                | Liveness. Never needs a token.              |
| GET    | `/readyz`      | → active backends, fallbacks        | `status` is `degraded` if a backend fell back. Never needs a token. |
| POST   | `/v1/classify` | `ClassifyRequest` → `ClassifyResponse` | `text` ≤ 4000 chars, optional `language_hint` (`en`/`hi`). |
| POST   | `/v1/embed`    | `EmbedRequest` → `EmbedResponse`    | 1–64 `texts`, each ≤ 2000 chars.            |
| POST   | `/v1/redact`   | `RedactRequest` → `RedactResponse`  | `text` ≤ 20000 chars.                       |

Requests reject unknown fields. Invalid requests get `422` (the error body never echoes the input),
bodies over 256 KB get `413` (from `Content-Length` before reading, or while a chunked upload
streams in, always before parsing), and
`/v1/*` gets `401` when a token is configured and the `Authorization: Bearer <token>` header is
missing or wrong. Logs carry lengths, counts, labels and the `x-request-id` header, never text.

## Configuration

All variables are optional.

| Variable             | Default                                  | Meaning |
| -------------------- | ---------------------------------------- | ------- |
| `AI_SERVICE_TOKEN`   | unset (no auth)                          | Require `Authorization: Bearer <token>` on `/v1/*` (constant-time compare). |
| `CLASSIFIER_BACKEND` | `rules`                                  | `rules` or `hf`. |
| `CLASSIFIER_MODEL`   | unset                                    | Hugging Face model id for `hf`. |
| `EMBEDDINGS_BACKEND` | `hash`                                   | `hash` or `sentence-transformers`. |
| `EMBEDDINGS_MODEL`   | `sentence-transformers/all-MiniLM-L6-v2` | Model id for `sentence-transformers`. |
| `REDACT_BACKEND`     | `regex`                                  | `regex` or `presidio`. |

An unknown backend name fails at startup. An optional backend that cannot load (extra not
installed, model missing, download failure) falls back to the default and shows up in `/readyz` as
`{"backend": "rules", "requested": "hf", "error": "ModuleNotFoundError"}`. Optional backends load
once at startup, never per request.

## Run

```sh
cd services/ai
uv sync                                   # Python 3.13 (pinned in .python-version) + dev tools
uv run uvicorn agentbazaar_ai.app:app --reload --port 8000
uv run pytest --cov                       # unit, property, API, contract tests; fails under 90 %
uv run ruff check . && uv run ruff format --check . && uv run mypy   # mypy is --strict on src
```

Optional backends: `uv sync --extra ml` (transformers, sentence-transformers, PyTorch) and
`uv sync --extra presidio`. See [MODELS.md](MODELS.md) before enabling them.

Docker (multi-stage, non-root, healthcheck on `/healthz`, port 8000):

```sh
docker build -t agentbazaar-ai services/ai
docker run --rm -p 8000:8000 -e AI_SERVICE_TOKEN=change-me agentbazaar-ai
```

## How the core API uses it

Point the core at the service and switch its adapters:

```sh
AI_SERVICE_URL=http://localhost:8000
CLASSIFIER_ADAPTER=ai-service
EMBEDDINGS_ADAPTER=ai-service
```

The core's defaults (`rules`, `hash`) keep working with this service down. If you set
`AI_SERVICE_TOKEN` here, the core's ai-service adapter must send it as a bearer token; the core's
config does not read a token variable yet.

## Backends

### Classifier: `rules-v1` (default)

Deterministic and multilingual: English, Hindi in Devanagari, and Hinglish (romanized Hindi).
Text is canonicalised (NFKC, casefold, nukta dropped, chandrabindu → anusvara, whitespace
collapsed), each intent has a table of cue phrases, and the first intent in this priority order with
a match wins:

`injection_attempt` → `human_handoff` → `competitor_claim` → `complaint` → `order_status` →
`return_request` → `make_offer` → `accept` → `ask_price` → `customization` → `availability` →
`search` → `product_question` → `off_topic` → `greeting` → `unknown`.

- `make_offer` needs an amount plus an offer cue ("can you do 1800", "₹2,000 final",
  "1800 mein de do", "my budget is 2k"), or a message that is only an amount ("1800?").
- `greeting` and short acknowledgements ("ok", "deal") count only when they are the whole message.
- `competitor_claim` needs a store mention plus a price claim, a third party selling "for ₹N", or
  an explicit phrase ("cheaper elsewhere", "dusri dukaan").
- Entities: `amount_inr` from `₹2,399`, `Rs. 2399`, `INR 2399.50`, `2.5k`, `1.5 lakh`,
  `2399 rupees`, `2399/-`, Indian digit grouping (`1,00,000`), Devanagari digits, or a bare number
  after an offer cue. `quantity` from digit forms only (`3 units`, `x5`, `5 pcs`, `qty 4`); words
  like "do" (two / give) are ambiguous. A number is never both.
- `risk`: `high` for injection attempts, `medium` for complaints or amounts over ₹1,00,000.
- `complexity`: `high` with three or more constraint kinds (budget, compatibility, specs, quantity,
  deadline, customization) or more than 60 words; `medium` with two or more than 20 words.
- `confidence` grows with the number of distinct cues and shrinks with competing intents, within
  [0.35, 0.97] for a match; `unknown` is 0.2.
- `language`: `hi` if Devanagari letters dominate, `other` for other non-Latin scripts, `hinglish`
  for Latin text with two or more romanized-Hindi markers (one with `language_hint: "hi"`), else
  `en`.

### Classifier: `hf` (optional, `ml` extra)

Runs a Hugging Face `text-classification` checkpoint whose labels are the intent names. The model
decides only the intent and confidence; entities, language and complexity still come from the rules,
risk follows the model's intent, and a rules-detected injection attempt is never overridden. The
plan is a fine-tuned multilingual **Laya** checkpoint here; see [MODELS.md](MODELS.md).

### Embeddings: `hash-256-v1` (default)

A dependency-free feature-hashing embedder, 256 dimensions. The TypeScript core implements the same
algorithm and both sides test against `tests/fixtures/hash_embeddings.json`, so changing anything
below needs a new model name.

1. `text = unicodedata.normalize("NFKC", text).lower()`
2. `tokens = re.findall(r"\w+", text)` (Unicode `\w`)
3. For each token `t`: feature `"w:" + t`, plus every code-point trigram of `"#" + t + "#"` as
   `"c:" + trigram` (a 1-character token gives the single trigram `#a#`).
4. For each feature, `h = fnv1a_32(feature.encode("utf-8"))` (offset basis 2166136261, prime
   16777619, mod 2³²); `vec[h % 256] += 1.0 if (h >> 31) & 1 == 0 else -1.0`.
5. L2-normalise; an all-zero vector stays all zeros.

Porting notes for JavaScript: Python's `\w` is `/[\p{L}\p{N}_]+/gu` (plain `\w` is ASCII-only in
JS); take trigrams over `Array.from(...)` code points, not UTF-16 units; use
`Math.imul(h ^ byte, 16777619) >>> 0`; and normalise by `Math.sqrt` of the sum of squares (the
counts are integers, so the result is bit-identical). Python's `\w` excludes combining marks, so a
Devanagari word is split at vowel signs (`नाम` gives the tokens `न`, `म`); the fixture pins this
behaviour, and a better tokenizer would have to ship as a new model name.

### Embeddings: `sentence-transformers` (optional, `ml` extra)

Normalised sentence embeddings from `EMBEDDINGS_MODEL`. Vectors from different models live in
different spaces: re-embed the catalogue when switching, and never mix them with hash vectors.

### Redaction: `regex` (default)

A port of `apps/api/src/shared/observability/redact.ts`: EMAIL, CARD (Luhn-checked), AADHAAR,
PHONE (Indian), PAN, UPI and PINCODE (only after "pin", "pincode" or "postal code"). Earlier rules
win overlaps, and each finding is replaced by `[TYPE]`. The regexes keep JavaScript semantics
(ASCII `\d`, `\w` and `\b`; JavaScript's `\s`), so both sides find the same spans. Two TS patterns
that backtrack quadratically on long input were rewritten into equivalent linear forms.

Offsets in `findings` are **code points** into the original text. JavaScript strings index UTF-16
units, so convert before slicing when the text contains characters outside the BMP (emoji).

Known gaps inherited from `redact.ts`, kept for parity until both sides change together:
`0`-prefixed mobile numbers (`09876543210`) are not redacted, because `\b` never holds between the
`0` and the next digit (pinned as a strict xfail in `tests/test_redaction.py`), and a card match
swallows the separator after it when a word follows (`card [CARD]thanks`).

### Redaction: `presidio` (optional, `presidio` extra)

Adds Presidio NER findings (names, locations, and so on, English only) to the regex findings; the
regex findings win overlaps.
