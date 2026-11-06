# Search benchmark: lite, growth and scale engines

How the three search engines compare on relevance and latency, from real runs against real engines. The
targets come from the development plan:

| Milestone | Engine | Definition of done |
| --- | --- | --- |
| G1 | Meilisearch (growth) | Golden-set recall at least equal to lite; search p95 under 50 ms at 100,000 products |
| S2 | OpenSearch + Qdrant (scale) | Relevance parity with growth on the golden set at 100,000 products and all their variants |

Every number on this page comes from a run whose commit, hardware and command are recorded next to it. A run
that has not happened yet says so.

## What is measured

All three engines are filled from the same database by the production code path: `generateCatalog` from
`@agentbazaar/testkit` (deterministic seed) is imported, and `SearchIndexer.reindexAll()` (what `cli reindex`
runs) writes every product with all its variants (SKUs, price range, stock) to Postgres (`search_documents`),
Meilisearch, and OpenSearch plus Qdrant. Embeddings are the default 256-dimension hash vectors.

**Golden set.** `apps/api/test/support/search-golden.ts` holds 56 queries over the catalog. The products that
count as relevant are judged from catalog facts (category, product name, brand, SKUs, prices, stock), never from
any engine's output:

| Kind | Queries | Examples (relevant products) |
| --- | --- | --- |
| Plain terms | 8 | `chocolate` (every chocolate), `power supply`, `mouse` |
| Phrases | 11 | `dark chocolate` (names containing it), `masala chai`, `mid tower case` |
| Typos | 7 | `keybaord`, `graphcs card`, `ceramc mug`, `darjeling tea` |
| SKUs of any variant | 5 | `THOCK-TK87-BLUE` (third variant of the TK-87), a lower-case SKU, two generated SKUs |
| Brands, alone or with a product type | 8 | `zentrix`, `cacao lane`, `keyvo mouse` (Keyvo mice only) |
| Category names | 5 | `graphics cards`, `pc cases`, `t-shirts` |
| Transliterated Hindi | 6 | `chai`, `kagaz`, `mitti mug`, `mithas chocolate` |
| Filters | 6 | `chocolate` under ₹50, `keyboard` by brand, `mug` in stock only, browse a category by brand |

Devanagari queries are not in the set: search documents carry the English product and category names only, so
no engine can match them yet.

Scores, averaged over the queries:

- **recall@10**, capped (BEIR's R_cap@10): relevant products in the top 10 divided by min(10, number of
  relevant products). Most queries have far more than 10 relevant products, so this asks "are the first 10
  results all relevant", and for SKU queries "is the product in the first 10".
- **nDCG@10** with binary relevance, which also rewards putting relevant products first.

Pass criteria, asserted by `apps/api/test/services/search-golden.spec.ts`: Meilisearch recall@10 at least equal
to Postgres (G1), and OpenSearch plus Qdrant at least equal to Meilisearch (S2).

**Latency.** The same file times 100 mixed queries, after 10 warm-up queries, through `SearchService.search()`,
the code path of `GET /api/v1/products` and the MCP `search_products` tool, including the analytics write each
search records. The workload is the one of the [lite benchmark](lite.md#1-search-latency-at-10000-products):
typos, a SKU, a query with no hits, browsing, six filter combinations and second pages. Pass: p95 under 50 ms
for Meilisearch and for OpenSearch plus Qdrant. Postgres is timed for reference only.

**Also checked** in the same run: paging to the API's deepest page (offset 5,000) and exact browse totals in
every engine. `apps/api/test/services/search-engines.spec.ts` covers the rest on 400 products: indexing through
the outbox, updates, stock changes and deletes reaching every engine, any variant's SKU finding its product, and
identical totals, facets and pages for filtered browsing.

## How to run

Two workflows run the same file:

- **Services** (`.github/workflows/services.yml`, every push to `main`): 10,000 products, alongside the other
  real-service suites, so its latencies carry the noise of a busy runner.
- **Search benchmark** (`.github/workflows/search-benchmark.yml`, when search code changes and nightly at 02:30
  UTC): 100,000 products with only Postgres, Meilisearch, OpenSearch and Qdrant running. It prints the runner's
  CPU and memory first and the engines' memory at the end.

Locally, with Docker:

```bash
docker compose -f tests/infra/docker-compose.yml up -d --wait postgres meilisearch opensearch qdrant
pnpm install --frozen-lockfile && pnpm turbo run build --filter=@agentbazaar/api^...
SEARCH_BENCH_PRODUCTS=100000 VITEST_MAX_WORKERS=1 \
  pnpm --filter @agentbazaar/api exec vitest run --project services test/services/search-golden.spec.ts
```

The test prints the import and reindex times, the golden-set scores (with the irrelevant results of every query
below full recall, per engine) and, per engine, the latency line and its three slowest queries.

## Results

### 100,000 products, 2026-11-06

[Search benchmark run 42205990191](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42205990191), commit
`0b9711c`. All five tests passed.

| Item | Value |
| --- | --- |
| Runner | GitHub-hosted `ubuntu-latest` (image ubuntu-24.04): 4 vCPUs, AMD EPYC 7763 (2 cores, 2 threads each), 15 GiB RAM |
| Engines | Postgres 18 with pgvector (`pgvector/pgvector:pg18`), Meilisearch 1.15, OpenSearch 2.19.1 (512 MB heap), Qdrant 1.15.0, in Docker on the same runner |
| Catalog | 100,000 products with 172,843 variants (`generateCatalog`, default seed) |
| Embeddings | `hash-256-v1` (the default) |

| Engine | recall@10 | nDCG@10 | p50 | p95 | max | p95 target |
| --- | --- | --- | --- | --- | --- | --- |
| Postgres (lite) | 1.000 | 1.000 | 162.1 ms | 366.1 ms | 612.6 ms | none at this size |
| Meilisearch (growth) | <!-- METRIC:search_meili_recall_100k -->1.000<!-- /METRIC --> | 1.000 | 8.2 ms | <!-- METRIC:search_meili_p95_ms_100k -->47.9<!-- /METRIC --> ms | 52.0 ms | under 50 ms: met |
| OpenSearch + Qdrant (scale) | <!-- METRIC:search_scale_recall_100k -->1.000<!-- /METRIC --> | 1.000 | 14.2 ms | <!-- METRIC:search_scale_p95_ms_100k -->24.2<!-- /METRIC --> ms | 30.7 ms | under 50 ms: met |

Every kind of query (terms, phrases, typos, SKUs, brands, category names, transliterated Hindi, filters) scored
1.000 on every engine. G1 is met (growth recall equals lite, p95 under 50 ms) and so is S2 (scale equals growth).

- **Meilisearch passes with little room:** its three slowest queries (50 to 52 ms) are all text with a brand
  filter that no keyword matches (`ceramic mug`, `darjeeling first flush`, `keybaord`, each with brand Thock), where
  the vector leg searches until it finds neighbours inside the filter.
- **Postgres is the lite engine at ten times its size:** its vector leg scans every matching row (a documented
  shortcut, fine to about 50,000 products), so broad terms are slowest (`chocolate` 613 ms). The lite budget is
  p95 under 150 ms at 10,000 products ([lite.md](lite.md)).
- **Indexing until searchable:** importing 100,000 products took 22.8 s; `reindexAll()` then took 101.3 s into
  Postgres, 32.8 s into Meilisearch (until every task succeeded) and 41.1 s into OpenSearch and Qdrant (until
  refreshed).
- **Memory after the run** (`docker stats`): OpenSearch 1.06 GiB, Meilisearch 212 MiB, Postgres 192 MiB, Qdrant
  67 MiB.
- **Deep pages:** offset 5,000 returned 50 products, with a total of 100,000, in every engine.

### 10,000 products, every push

[Services run 42205990257](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42205990257), commit `0b9711c`,
same runner type, with the other real-service suites running in parallel.

| Engine | recall@10 | nDCG@10 | p50 | p95 | max | Reindex until searchable |
| --- | --- | --- | --- | --- | --- | --- |
| Postgres (lite) | 1.000 | 1.000 | 14.3 ms | 31.6 ms | 41.2 ms | 12.7 s |
| Meilisearch (growth) | 1.000 | 1.000 | 5.0 ms | 46.6 ms | 49.2 ms | 3.5 s |
| OpenSearch + Qdrant (scale) | 1.000 | 1.000 | 18.1 ms | 35.5 ms | 58.8 ms | 6.5 s |

### Before the fixes

The first run of the golden set ([Services run 42198801458](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42198801458),
commit `9fce948`, 10,000 products) scored recall@10 0.982 for lite, 1.000 for growth and 0.961 for scale, with
Meilisearch at p95 1,176 ms. The misses were SKU lookups (lite and scale) and two category queries (scale). The
next section lists what was wrong.

A perfect score means the set no longer separates the engines. Harder queries belong in it as the engines grow:
Devanagari once search documents carry Hindi names, and meaning rather than spelling (`chai` for every tea) once
the AI-service embeddings replace the hash vectors.

## What the real engines taught us

The adapters were first written against fake HTTP responses. Running them against live engines found these
problems, now fixed and covered by the tests above:

- **Meilisearch rejected every search.** Facets are only allowed on filterable attributes, and `brand` and
  `category_top` were not filterable.
- **Meilisearch stopped at 1,000 hits.** Its default `maxTotalHits` capped both the totals and the pages. It is
  now 5,050, the API's deepest page (offset 5,000 plus 50), and totals come from the facet counts, which are
  exhaustive, so a browse of 10,000 products reports 10,000.
- **Meilisearch hybrid search answered gibberish and counted the whole index.** The vector leg returns
  neighbours however far away they are, and they count towards the total and the facets. Hits now need a
  ranking score of 0.65: Meilisearch scores a vector hit (1 + cosine) / 2, so this is the cosine floor of 0.3
  that the Postgres and Qdrant legs use. Totals and facets come from a keyword-only count in the same
  multi-search request, so, as with OpenSearch, the total of a hybrid query is a lower bound.
- **Meilisearch took over a second per query** (p95 1,176 ms at 10,000 products) while that floor was its
  `rankingScoreThreshold` setting. The floor is now applied to the returned page (`showRankingScore`), and p95
  fell to 47 ms on the same runner.
- **Exact SKUs fell out of the top 10 in Postgres and OpenSearch.** Reciprocal rank fusion only sees ranks, so a
  product that only the keyword leg found (its SKU) lost to products of the same brand and type that every leg
  found. An exact SKU of any variant now puts its product first in both, as Meilisearch's exactness rule already
  did.
- **SKU fragments matched words in OpenSearch.** The standard analyzer split `CACAOL-CHOCOL-PC-SINGLE` into
  parts, so a chocolate ranked for "pc cases". A SKU is now one lower-case token, weighted above a brand word
  (`skus^10`), and the single keyword ranking counts twice in the fusion: the balance lite has between its two
  lexical legs (full text, trigram) and its vector leg.
- **OpenSearch's filtered and fuzzy queries were the slowest.** Fuzzy terms now keep their first letter
  (`prefix_length` 1, as every golden typo does) and the Qdrant collection has payload indexes on every filtered
  field. An index created before these changes keeps its old mapping: delete it and run `cli reindex`.
- **Index creation timed out.** Creating a Qdrant collection took about 1.6 s on the test stack, close to the
  2 s timeout searches use. Index creation and writes now get 15 s.
- **One HTTP request per product.** Reindexing now writes a page of 500 products per engine request (a
  multi-row upsert, OpenSearch `_bulk` with its per-item errors checked, Meilisearch and Qdrant batches) and reads
  each page from the catalog in three queries, so memory stays flat at any catalog size and `cli reindex`
  prints its progress.

Writes are asynchronous in both HTTP engines: Meilisearch applies them as tasks and OpenSearch shows them after
its next refresh (one second by default), so a product changed through the outbox becomes searchable a moment
after its event is consumed.
