# Models and their licences

AgentBazaar runs with **no machine-learning model at all** by default: the template LLM adapter, the rules classifier and hash embeddings are plain code under this repository's MIT licence. Every model below is optional, chosen by the operator, and **no model weights are distributed in this repository**. Whoever enables a model is responsible for accepting its licence or terms of service.

Whatever model you choose, it only writes words. Prices, discounts, stock and permissions come from the policy engine, and the output guard (`apps/api/src/modules/agent/domain/guard.ts`) replaces any reply that contains a number the services did not produce.

## Inventory

| Component | Used for | Default? | What it is | Licence or terms | Distributed here? |
| --- | --- | --- | --- | --- | --- |
| `template` LLM adapter | Seller replies | Yes | Deterministic English and Hindi wording in code | MIT (this repository) | Code only |
| Claude, via the Anthropic API (`LLM_ADAPTER=anthropic`) | Rephrasing replies; small tier `claude-haiku-5-5`, large tier `claude-sonnet-5-5` by default | No | Hosted proprietary model reached with the operator's API key | Anthropic's commercial terms and usage policies | No |
| Any model behind an OpenAI-compatible server (`LLM_ADAPTER=openai-compatible`), for example an open-weight model on vLLM | Rephrasing replies | No | Self-hosted or hosted model chosen by the operator | The model's own licence (open-weight licences differ: some are Apache-2.0, others add use restrictions); record it below | No |
| `rules-v1` classifier | Intent, language and risk for the router | Yes | Deterministic cue tables in TypeScript and Python | MIT (this repository) | Code only |
| Hugging Face classifier (`CLASSIFIER_BACKEND=hf` in `services/ai`, model named by `CLASSIFIER_MODEL`) | Intent classification | No | The plan's target is a multilingual Laya checkpoint fine-tuned and calibrated on project-labelled traffic | **TBD: confirm the base checkpoint's licence and any fine-tuned weights' terms before use or distribution** | No |
| `hash-256-v1` embeddings | Vector leg of hybrid search | Yes | Feature hashing (FNV-1a over words and character trigrams), no learned weights; identical in TypeScript and Python | MIT (this repository) | Code only |
| `sentence-transformers/all-MiniLM-L6-v2` (`EMBEDDINGS_BACKEND=sentence-transformers` in `services/ai`) | Semantic search embeddings | No | Downloaded from Hugging Face at runtime | Apache-2.0 | No |
| Presidio (`REDACT_BACKEND=presidio` in `services/ai`) | PII detection on top of the regex redactor | No | Library plus the spaCy pipeline it loads | Presidio: MIT. Check the licence of the spaCy model you install | No |

Changing the hash embedding algorithm requires a new model name, because the TypeScript and Python implementations are tested against the same fixtures (`services/ai/tests/fixtures/hash_embeddings.json`).

## Data rules for any model

- **Training and evaluation data is synthetic or labelled by the project.** It is never scraped from the web and never taken from customers' conversations, orders or personal data.
- **Operators who fine-tune on their own traffic** must have a lawful basis and consent for that purpose, redact personal data first, and record the result below. AgentBazaar stores LLM traces with personal data redacted (`llm_traces`), which is the only form that may be considered for labelling.
- **Buyer text is untrusted data.** It reaches a model only as quoted context, never as instructions, and never together with floors, costs, margins or other customers' data.
- **Hosted providers receive the prompt you send them.** With a hosted LLM, redacted buyer text and buyer-visible facts leave your server. Disclose this in your privacy notice and check the provider's data-retention terms; see `docs/compliance/`.

## Recording a model you add

Add a row to the inventory and a section like this for any model you enable in production or fine-tune:

```text
Name and version:      e.g. <org>/<model>@<revision>
Source:                where the weights or API come from
Licence or terms:      exact licence, with a link; any use restrictions
Used for:              classifier | phrasing | embeddings | redaction
Fine-tuned?            base model, data sources and their legal basis, date, who approved it
Evaluation:            eval suite and results (accuracy, calibration, adversarial leak rate)
Distributed?           whether weights are shipped anywhere, and under what terms
```

Model licences are part of the release checklist: a model whose licence is unknown is not enabled by default and its weights are not distributed.
