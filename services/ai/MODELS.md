# Models and licences

The default backends (`rules-v1` classifier, `hash-256-v1` embeddings, `regex` redaction) use no
models and download nothing. Their runtime dependencies are all permissively licensed: FastAPI,
Pydantic and Uvicorn and their dependencies are MIT, BSD-3-Clause, Apache-2.0 or PSF-2.0.

Everything below is opt-in through an extra and an environment variable, and is never loaded by the
tests.

## Embeddings: `sentence-transformers/all-MiniLM-L6-v2`

- Enabled by `EMBEDDINGS_BACKEND=sentence-transformers` with the `ml` extra.
- Licence: Apache-2.0 (per the model card on the Hugging Face Hub).
- 384 dimensions, trained mostly on English: expect weak results for Hindi and Hinglish. For those,
  evaluate a multilingual sentence-transformers model and check its model card licence first.
- Downloaded from the Hugging Face Hub at startup on first use, then cached.
- Changing the model changes the vector space: re-embed the catalogue, and never mix these vectors
  with `hash-256-v1` vectors.

## Classifier: the planned Laya checkpoint

- Enabled by `CLASSIFIER_BACKEND=hf` and `CLASSIFIER_MODEL=<model id>` with the `ml` extra.
- The intended model is a fine-tuned multilingual "Laya" intent classifier. **Its licence (and the
  licence of the base model it is fine-tuned from) must be confirmed before it is used or
  distributed.**
- Training data must be synthetic or labelled by the project. Do not train on real customer
  conversations or anything containing personal data.
- The checkpoint's labels must be the 16 intent names from the contract (case-insensitive). Any
  other label falls back to the rules result.
- The rules classifier stays in front of it as the prompt-injection guard and as the source of
  entities, language and complexity. Use the tables in `tests/test_classifier.py` as a regression
  set before switching.

## Redaction: Presidio

- Enabled by `REDACT_BACKEND=presidio` with the `presidio` extra.
- `presidio-analyzer` is MIT and uses spaCy (MIT). Its default English NLP model,
  `en_core_web_lg`, is MIT; it is not on PyPI and is fetched separately
  (`uv run python -m spacy download en_core_web_lg`) or by Presidio on first start.
- Configured for English NER only; the regex rules still cover Indian identifiers.

## Transitive licences of the extras

The `ml` extra brings PyTorch (BSD-3-Clause) and Hugging Face libraries such as transformers,
sentence-transformers, huggingface-hub, tokenizers and safetensors (Apache-2.0). Both extras also
pull in `tqdm` (MPL-2.0 AND MIT) and `certifi` (MPL-2.0), which the default install does not
contain. MPL-2.0 is file-level copyleft and generally fine to use unmodified, but run a licence scan
of the exact image before shipping either extra.
