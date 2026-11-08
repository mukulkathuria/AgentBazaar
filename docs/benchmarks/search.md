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

**Golden set.** `apps/api/test/support/search-golden.ts` holds 66 queries over the catalog. The products that
count as relevant are judged from catalog facts (category, product name, brand, SKUs, prices, stock), never from
any engine's output. They run through `SearchService`, so Hindi words are read the way shoppers' are:

| Kind | Queries | Examples (relevant products) |
| --- | --- | --- |
| Plain terms | 8 | `chocolate` (every chocolate), `power supply`, `mouse` |
| Phrases | 11 | `dark chocolate` (names containing it), `masala chai`, `mid tower case` |
| Typos | 7 | `keybaord`, `graphcs card`, `ceramc mug`, `darjeling tea` |
| SKUs of any variant | 5 | `THOCK-TK87-BLUE` (third variant of the TK-87), a lower-case SKU, two generated SKUs |
| Brands, alone or with a product type | 8 | `zentrix`, `cacao lane`, `keyvo mouse` (Keyvo mice only) |
| Category names | 5 | `graphics cards`, `pc cases`, `t-shirts` |
| Transliterated Hindi | 6 | `chai`, `kagaz`, `mitti mug`, `mithas chocolate` |
| Hindi in Devanagari | 10 | `कीबोर्ड` (every keyboard), `कप` (every mug), `डार्क चॉकलेट`, `ग्राफिक्स कार्ड`, `मिठास चॉकलेट` (Mithas) |
| Filters | 6 | `chocolate` under ₹50, `keyboard` by brand, `mug` in stock only, browse a category by brand |

Scores, averaged over the queries:

- **recall@10**, capped (BEIR's R_cap@10): relevant products in the top 10 divided by min(10, number of
  relevant products). Most queries have far more than 10 relevant products, so this asks "are the first 10
  results all relevant", and for SKU queries "is the product in the first 10".
- **nDCG@10** with binary relevance, which also rewards putting relevant products first.

Pass criteria, asserted by `apps/api/test/services/search-golden.spec.ts`: Meilisearch recall@10 at least equal
to Postgres (G1), OpenSearch plus Qdrant at least equal to Meilisearch (S2), and at least 0.9 on the Devanagari
queries in every engine.

**Latency.** The same file times 100 mixed queries, after 10 warm-up queries, through `SearchService.search()`,
the code path of `GET /api/v1/products` and the MCP `search_products` tool, including the analytics write each
search records. The workload is the one of the [lite benchmark](lite.md#1-search-latency-at-10000-products):
typos, a SKU, a query with no hits, a query in Hindi, browsing, six filter combinations and second pages. Postgres
is timed for reference only. The pass mark for Meilisearch and for OpenSearch plus Qdrant depends on the run:

- **100,000 products** (Search benchmark workflow, only the search engines on the runner): p95 under 50 ms, the
  plan's budget.
- **10,000 products** (Services workflow): p95 under 100 ms. That runner starts eleven services and runs a
  dozen suites at once, and identical code measured Meilisearch at 46.6 to 52.6 ms there, so a 50 ms mark
  failed on noise. 100 ms still fails on a regression like the p95 of 1,176 ms that `rankingScoreThreshold`
  caused; smaller ones, such as the 40 ms transport stall below, are the dedicated benchmark's to catch. Every
  recall assertion is the same in both runs.

**Also checked** in the same run: paging to the API's deepest page (offset 5,000) and exact browse totals in
every engine. `apps/api/test/services/search-engines.spec.ts` covers the rest on 400 products: indexing through
the outbox, updates, stock changes and deletes reaching every engine, any variant's SKU finding its product,
identical totals, facets and pages for filtered browsing, and 30 products the engines cannot tell apart paged
seven at a time (by text and by browsing), twice, with no product repeated or skipped and the same order both
times.

## How to run

Two workflows run the same file:

- **Services** (`.github/workflows/services.yml`, every push to `main`): 10,000 products, alongside the other
  real-service suites, so its latencies carry the noise of a busy runner.
- **Search benchmark** (`.github/workflows/search-benchmark.yml`, when search code changes and nightly at 02:30
  UTC): 100,000 products with only Postgres, Meilisearch, OpenSearch and Qdrant running. It prints the runner's
  CPU and memory first and the engines' memory at the end, and sets `SEARCH_BENCH_PROFILE`, which adds a profile
  of where Meilisearch spends its time (see [below](#where-meilisearchs-time-went)).

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

### 100,000 products, 2026-11-08

[Search benchmark run 42441720909](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42441720909), commit
`2bc6dbc`. All six tests passed.

| Item | Value |
| --- | --- |
| Runner | GitHub-hosted `ubuntu-latest` (image ubuntu-24.04): 4 vCPUs, AMD EPYC 7763 (2 cores, 2 threads each), 15 GiB RAM |
| Engines | Postgres 18 with pgvector (`pgvector/pgvector:pg18`), Meilisearch 1.15, OpenSearch 2.19.1 (512 MB heap), Qdrant 1.15.0, in Docker on the same runner |
| Catalog | 100,000 products with 172,843 variants (`generateCatalog`, default seed) |
| Embeddings | `hash-256-v1` (the default) |

| Engine | recall@10 | nDCG@10 | p50 | p95 | max | p95 target |
| --- | --- | --- | --- | --- | --- | --- |
| Postgres (lite) | 1.000 | 1.000 | 174.6 ms | 459.0 ms | 638.6 ms | none at this size |
| Meilisearch (growth) | <!-- METRIC:search_meili_recall_100k -->1.000<!-- /METRIC --> | 1.000 | 4.6 ms | <!-- METRIC:search_meili_p95_ms_100k -->11.4<!-- /METRIC --> ms | 32.9 ms | under 50 ms: met |
| OpenSearch + Qdrant (scale) | <!-- METRIC:search_scale_recall_100k -->1.000<!-- /METRIC --> | 1.000 | 14.0 ms | <!-- METRIC:search_scale_p95_ms_100k -->27.6<!-- /METRIC --> ms | 51.2 ms | under 50 ms: met |

All 66 queries, the ten in Devanagari included, scored 1.000 in every engine. G1 is met (growth recall equals
lite, p95 under 50 ms) and so is S2 (scale equals growth).

- **Meilisearch's slowest queries** (23 to 33 ms) are text with a brand filter that no keyword matches
  (`wireless mouse`, `chocolat`, `mid tower case`, each with brand Thock), where the vector leg searches until it
  finds neighbours inside the filter. That is Meilisearch's own processing time.
- **Postgres is the lite engine at ten times its size:** its vector leg scans every matching row (a documented
  shortcut, fine to about 50,000 products), so broad terms are slowest (`cotton t-shirt` 639 ms). The lite budget
  is p95 under 150 ms at 10,000 products ([lite.md](lite.md)).
- **Indexing until searchable:** importing 100,000 products took 23.3 s; `reindexAll()` then took 100.1 s into
  Postgres, 33.3 s into Meilisearch (until every task succeeded) and 40.1 s into OpenSearch and Qdrant (until
  refreshed).
- **Memory after the run** (`docker stats`): OpenSearch 1.04 GiB, Meilisearch 207 MiB, Postgres 190 MiB, Qdrant
  67 MiB.
- **Deep pages:** offset 5,000 returned 50 products, with a total of 100,000, in every engine.

Earlier runs on the same runner type, for comparison:

| Run | Commit | Meilisearch p50 / p95 / max | OpenSearch + Qdrant p50 / p95 / max | Note |
| --- | --- | --- | --- | --- |
| [42205990191](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42205990191), 2026-11-06 | `0b9711c` | 8.2 / 47.9 / 52.0 ms | 14.2 / 24.2 / 30.7 ms | Engines over undici's `fetch` |
| [42440738958](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42440738958), 2026-11-08 | `f9a2158` | 4.3 / 18.6 / 42.9 ms | 12.3 / 22.1 / 38.6 ms | Engines over `node:http`; Intel Xeon Platinum 8573C runner |

### Where Meilisearch's time went

With p95 at 47.9 ms, the 10,000-product check in the noisier Services runner failed at 50.2 to 52.6 ms
([Services run 42212584179](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42212584179)). The profile
(`apps/api/test/services/meili-profile.ts`) times every query of the workload through the adapter and compares
the HTTP round trip with Meilisearch's own `processingTimeMs`:

| Run | Adapter p95 | HTTP round trip p95 | Meilisearch processing p95 (page / count query) |
| --- | --- | --- | --- |
| [42438949926](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42438949926), undici `fetch` | 46.1 ms | 45.9 ms | 16 / 4 ms |
| [42441720909](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42441720909), `node:http` | 10.8 ms | 10.7 ms | 8 / 4 ms |

The slowest requests carried a near-constant 42 to 43 ms that Meilisearch did not account for (`mechanical
keyboard` under ₹1,000: 3 ms of processing, 46 ms round trip). Re-sending each slow request with one part
changed ruled out the facet count, the attributes retrieved and Postgres. Then
[run 42439877974](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42439877974) sent the same requests
through three transports: Node's built-in `fetch` (undici) took 43 to 47 ms, `node:http` 1.4 to 6.4 ms, whether
the connection was kept alive or closed. Meilisearch answers with chunked bodies (`transfer-encoding: chunked`);
given the same requests and the same answers, only `fetch` waited. Undici already disables Nagle's algorithm, so
no socket setting explains it, and the exact cause inside undici was not chased further.
`JsonHttp`, the client of every engine and of the AI service, now uses `node:http(s)` with kept-alive connections,
and Meilisearch's p95 fell to 18.6 ms and then 11.4 ms in the next runs without any change to search settings or
recall.

### 10,000 products, every push

[Services run 42441921267](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42441921267), commit `22ea369`,
same runner type, with the other real-service suites running in parallel. All 66 golden queries, Devanagari
included, scored 1.000 in every engine.

| Engine | recall@10 | nDCG@10 | p50 | p95 | max | Reindex until searchable |
| --- | --- | --- | --- | --- | --- | --- |
| Postgres (lite) | 1.000 | 1.000 | 15.9 ms | 43.0 ms | 59.7 ms | 11.8 s |
| Meilisearch (growth) | 1.000 | 1.000 | 4.2 ms | 6.8 ms | 16.9 ms | 4.0 s |
| OpenSearch + Qdrant (scale) | 1.000 | 1.000 | 21.4 ms | 41.5 ms | 71.1 ms | 6.6 s |

Before the transport change, the same check measured Meilisearch at p95 46.6 ms
([run 42205990257](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42205990257)) and failed at 50.2 to
52.6 ms in [run 42212584179](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42212584179).

### Before the fixes

The first run of the golden set ([Services run 42198801458](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42198801458),
commit `9fce948`, 10,000 products) scored recall@10 0.982 for lite, 1.000 for growth and 0.961 for scale, with
Meilisearch at p95 1,176 ms. The misses were SKU lookups (lite and scale) and two category queries (scale). The
next section lists what was wrong.

A perfect score means the set no longer separates the engines. Harder queries belong in it as the engines grow:
Hindi words outside the term map, and meaning rather than spelling (`chai` for every tea) once the AI-service
embeddings replace the hash vectors.

## Hindi queries

Search documents carry English text only, so a query in Devanagari (`कीबोर्ड`, `चॉकलेट`) used to find nothing in
any engine. `SearchService` now reads the Hindi words of a query through `HINDI_TERMS`
(`apps/api/src/modules/search/domain/hindi-terms.ts`), a reviewed map to the words the catalog is written in:

- **Product types and categories** go to English. The category entries are the catalog's own Hindi category
  names (`ग्राफ़िक्स कार्ड` to `graphics card`), plus common shop words (`कप` and `मग` to `mug`, `कॉपी` to
  `notebook`, `डार्क` to `dark`).
- **Brands** go to the catalog's own Hinglish spelling (`मिठास` to `mithas`, `कागज़` to `kagaz`).
- A phrase wins over its words (`चाय कहानी` is the brand Chai Kahani, `चाय` alone is tea). Only whole words are
  replaced, the nukta is optional (`ग्राफिक्स` and `ग्राफ़िक्स` both work), and words outside the map are kept as
  typed.
- Analytics records what the shopper typed. REST, the MCP tool and the chat all go through `SearchService`, so
  every engine and every channel gets the same reading.

The map is data, not code: a new word is one reviewed line. Its unit tests check that every key is Devanagari and
every value is plain lower-case catalog text. Not covered yet: Hindi words outside the map, and product names
translated into Hindi. Those need Hindi text in the search documents or multilingual embeddings from the AI
service.

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
- **Many Meilisearch requests through Node's `fetch` stalled about 40 ms**, with chunked answers, which put p95
  at 47.9 ms. The engines are now called over `node:http(s)`, and p95 fell to 11.4 ms ([above](#where-meilisearchs-time-went)).
- **Equal scores had no order of their own in OpenSearch**, so tied products could swap places between requests
  and a page could repeat or skip one. Every path now ends on the product id: OpenSearch sorts text on `_score`
  then `id` and browsing on name then `id`, Qdrant's tied hits are put in id order before fusion, Meilisearch's
  ranking rules end with `id:asc` (after exactness, so only ties move) and its browsing sorts on name then id,
  and fusion breaks ties by id in code-unit order, the order Postgres's uuid and OpenSearch's keyword sorts use.
  At 100,000 products the extra sort cost nothing measurable ([run 42451009235](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42451009235):
  OpenSearch p95 20.8 ms, Meilisearch 15.1 ms, recall 1.000).
- **Index creation timed out.** Creating a Qdrant collection took about 1.6 s on the test stack, close to the
  2 s timeout searches use. Index creation and writes now get 15 s.
- **One HTTP request per product.** Reindexing now writes a page of 500 products per engine request (a
  multi-row upsert, OpenSearch `_bulk` with its per-item errors checked, Meilisearch and Qdrant batches) and reads
  each page from the catalog in three queries, so memory stays flat at any catalog size and `cli reindex`
  prints its progress.

Writes are asynchronous in both HTTP engines: Meilisearch applies them as tasks and OpenSearch shows them after
its next refresh (one second by default), so a product changed through the outbox becomes searchable a moment
after its event is consumed.
