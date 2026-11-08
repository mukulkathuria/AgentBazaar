# Browser journeys, Lighthouse, Schemathesis and ZAP

The Phase 1 gates that need the running store: **end-to-end journeys in real browsers (smoke on every push and
pull request, every browser nightly), screenshot baselines, axe accessibility (no serious violations), Lighthouse
performance budgets, API contract fuzzing against the OpenAPI document, and an OWASP ZAP baseline scan (release
gate: no High findings).** This page says what runs where, how to run each gate on your machine, the budgets and
the results. Every number below comes from a real run on 2026-11-08: on GitHub Actions `ubuntu-latest` (the run
is named) or on the Windows 11 laptop the work was done on (said where).

## What runs where

| Gate | Tool | What it checks | Workflow | Cadence | Fails when |
| --- | --- | --- | --- | --- | --- |
| Journeys, smoke | Playwright 1.64 | 17 `@smoke` tests on desktop Chromium (table below) | `web-e2e.yml` | Every push and pull request | A test fails twice (one retry in CI) |
| Accessibility | `@axe-core/playwright` 4.14 | WCAG 2.0, 2.1 and 2.2 A/AA on 10 page states, English and Hindi, including the chat dialog and the checkout error state | `web-e2e.yml` (part of the smoke run) | Every push and pull request | Any serious or critical violation |
| Screenshots | Playwright `toHaveScreenshot` | Home, product (personalisable mug), search results, empty cart on Linux Chromium; product grids whose order ties are masked | `web-e2e.yml`, its own step before the journeys | Every push and pull request | More than 1% of pixels differ |
| Journeys, every browser | Playwright | Every journey on Chromium, Firefox, WebKit, Pixel 7 and iPhone 15 | `web-e2e.yml` (`full=true` on dispatch) | Nightly 01:30 UTC | A test fails twice |
| Performance budgets | Lighthouse CI 0.15.1 (`apps/web/lighthouserc.json`) | Home, category, product and search pages, median of 5 runs, mobile emulation | `web-e2e.yml` | Every push and pull request | Any budget below |
| API contract fuzzing | Schemathesis 4.33.1 (`tests/dast/schemathesis.toml`) | All 54 REST operations of `packages/contracts/generated/openapi.json`: `not_a_server_error`, `status_code_conformance`, `content_type_conformance`, `response_schema_conformance` | `dast.yml` | Pushes and pull requests replay seed `20261108`; nightly 03:00 UTC and dispatch draw fresh seeds | Any check fails |
| DAST | OWASP ZAP baseline (`ghcr.io/zaproxy/zaproxy:stable`, pinned by digest) | Spider plus passive rules on the web app and the API | `dast.yml` | Every push, pull request and nightly | A `FAIL` rule matches, or any High alert not marked `IGNORE` in `.zap/rules.tsv` |

Both workflows build the API and the web app for production and start them with
[`scripts/e2e-stack.sh`](../../scripts/e2e-stack.sh), so the gates test what ships: the API on embedded Postgres
(PGlite) with mock payments and the seeded 300-product catalog, and the standalone Next.js server exactly as the
web image runs it. The script also seeds an MFA admin with the CLI, using keys it shares with the server, so the
admin and returns journeys can sign in; it writes `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` and
`E2E_ADMIN_TOTP_SECRET` to `$E2E_STATE_DIR/admin.env` (and to `$GITHUB_ENV` in Actions). Runs on `main` do not
cancel each other, so every push reports a result.

## Running the gates locally

Build once, then start the store (Git Bash or any POSIX shell; Windows works too):

```bash
pnpm install --frozen-lockfile
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm turbo run build --filter=@agentbazaar/api... --filter=@agentbazaar/web...
E2E_STATE_DIR=/tmp/ab-e2e bash scripts/e2e-stack.sh      # API :4000, web :3000; API_PORT / WEB_PORT to move them
set -a; . /tmp/ab-e2e/admin.env; set +a                  # the seeded admin, for the admin and returns journeys
```

`NEXT_PUBLIC_API_URL` is inlined into the browser bundle at build time, so build with the API port you start.
Stop the store with `kill $(cat /tmp/ab-e2e/*.pid)`.

**Playwright** (from `apps/web`; `pnpm exec playwright install --with-deps chromium` the first time):

```bash
pnpm exec playwright test --project=chromium --grep @smoke     # what pull requests run
pnpm exec playwright test --grep-invert @visual                # every browser and viewport, as the nightly does
pnpm exec playwright test e2e/a11y.spec.ts                     # axe only
E2E_BASE_URL=http://localhost:3101 pnpm exec playwright test   # a store on other ports
```

The screenshot baselines are Linux Chromium images, so `@visual` only compares on Linux. To refresh them, run
the *Web E2E* workflow by hand with `update-snapshots` ticked, download the `screenshot-baselines` artifact into
`apps/web/e2e/visual.spec.ts-snapshots/` and commit it. A baseline that is missing is written and uploaded by the
next run rather than failed, so deleting one is how to re-take it.

**Lighthouse CI** (needs Chrome; from `apps/web`):

```bash
npx --yes @lhci/cli@0.15.1 autorun --config=lighthouserc.json     # the URLs say :3000; override with --collect.url=...
```

**Schemathesis** (any machine with [uv](https://docs.astral.sh/uv/); from the repository root):

```bash
token=$(curl -s localhost:4000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"fuzz@example.com","password":"Fuzz-pass-2026","name":"Fuzz Tester","consents":{"terms":true}}' | jq -r .accessToken)
uvx schemathesis==4.33.1 --config-file tests/dast/schemathesis.toml run packages/contracts/generated/openapi.json \
  --url http://localhost:4000 --max-examples 100 --seed 20261108 \
  --checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance \
  --exclude-path-regex '^/api/v1/admin/' --exclude-path /api/v1/me/erase -H "Authorization: Bearer $token"
# admin operations: -H "Authorization: Bearer $(node tests/dast/admin-token.mjs)" --include-path-regex '^/api/v1/admin/'
```

On Windows set `PYTHONUTF8=1` (Schemathesis prints Unicode) and, in Git Bash, `MSYS_NO_PATHCONV=1` so
`/api/v1/...` filters are not rewritten into Windows paths. The API does not serve the OpenAPI document; the
generated file in `packages/contracts` is the contract, and CI checks it is up to date.

**ZAP baseline** (Docker, with the store on the host):

```bash
mkdir -p zap && cp .zap/rules.tsv zap/ && chmod -R a+w zap
docker run --rm --network host -v "$PWD/zap:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://localhost:3000 -c rules.tsv -I -m 2 -r zap-web.html -J zap-web.json
```

`dast.yml` pins the image by digest and scans `http://localhost:4000/api/v1/products?limit=5` the same way.

## Journeys

| Spec (`apps/web/e2e/`) | Journey |
| --- | --- |
| `shopping.spec.ts` | Browse from the home page, personalise a mug (non-returnable notice shown first), cart, checkout, pay on the mock gateway, see the order as paid |
| `search.spec.ts` | A misspelt query still finds the keyboard; the in-stock filter |
| `chat.spec.ts` | Ask the assistant for a price, counter-offer, accept the signed quote, follow the checkout link (negotiated price kept) |
| `returns.spec.ts` | Cash on delivery; the admin ships and delivers in the console; the shopper requests a return; the admin completes it |
| `account.spec.ts` | Register, download the data export, erase the account |
| `admin.spec.ts` | Admin signs in with password and TOTP, sees the dashboard, opens the approvals queue |
| `keyboard.spec.ts` | Keyboard only: skip link, search, product, add to cart; the chat dialog traps focus, closes on Escape and returns focus to its launcher |
| `i18n.spec.ts` | Switch to Hindi (`lang="hi"`, Hindi headings and labels), keep it across pages, Hindi assistant greeting, switch back |
| `network.spec.ts` | Slow network: the assistant shows it is typing and blocks a second send (`aria-busy`); offline: a failed send says so and the next one works |
| `no-js.spec.ts` | Without JavaScript, signing in or registering never puts credentials in the URL |
| `a11y.spec.ts` | axe on home (English and Hindi), category, search, product with and without the chat dialog, cart, checkout and its error state, account |
| `visual.spec.ts` | Screenshot baselines |

## Lighthouse budgets

Mobile emulation with Lighthouse's default simulated throttling; each page is judged on the median of 5 runs. The
budgets come from the first CI measurement (run 42445114646, 3 runs per page) with room for runner noise. Each
measurement had a slow first run on one or two pages (total blocking time 811 ms, then 555 ms), which is why a page
takes five runs and the median decides.

| Budget | Pages | CI, 5 runs (run 42447026108), per-page medians | CI, 3 runs (run 42445114646) | Laptop, 1 run |
| --- | --- | --- | --- | --- |
| Performance score ≥ 0.90 | all four | 0.97–0.98 | 0.98–0.99 | 0.85–0.96 |
| Accessibility score ≥ 0.95 | all four | 1.00 | 1.00 | 1.00 |
| Best practices score ≥ 0.95 | all four | 1.00 | 1.00 | 1.00 |
| SEO score ≥ 0.95 | home, category, product (search is `noindex` by design and scores 0.63) | 1.00 | 1.00 | 1.00 |
| Largest Contentful Paint ≤ 3.0 s | all four | 2.05–2.45 s | 1.89–2.41 s | 2.50–2.90 s |
| Total Blocking Time ≤ 300 ms | all four | 61–100 ms | 28–61 ms | 128–393 ms |
| Cumulative Layout Shift ≤ 0.05 | all four | 0 | 0 | 0 |
| JavaScript transferred ≤ 180 kB | all four | 157–163 kB | 157–163 kB | 157–163 kB |
| Everything transferred ≤ 215 kB | all four | 188–197 kB | 187–197 kB | 197–203 kB |

Tighten a budget when a change makes room under it; never loosen one to make a red run green without saying why
in the commit.

## Results

### Playwright and axe

On CI (run 42447026108) the 4 screenshots pass in 4.0 seconds and the 17 Chromium smoke tests in 20.2 seconds
with two workers (that run wrote the two masked baselines, committed afterwards). On the laptop against a local production build (`API_PORT=4101 WEB_PORT=3101`) the same 17
passed in 2.0 minutes. axe reports no serious or critical violation on any of the ten page states. The
cross-browser projects run from the nightly schedule.

### Schemathesis

With the fixes below every check passes. The seeded run on CI (run 42447026147, seed `20261108`, 100 examples per
operation) generated 5,082 cases on the 37 storefront and account operations, 2,438 on the 16 admin operations and
125 on erasure, all passing; the laptop run with the same seed gave 5,022, 2,438 and 125. A fresh-seed run
(run 42443522775) passed 4,936, 2,322 and 125.

What fuzzing found, and the fixes (each with a regression test in `apps/api/test/regression/contract-fuzz.e2e.spec.ts`
or the contracts spec):

| Finding | Check | Fix |
| --- | --- | --- |
| A NUL character (U+0000) in a query, path parameter or JSON body reached Postgres, which cannot store it in text or jsonb: 500 | `not_a_server_error` | `parseOrThrow`, behind every `ZodPipe`, answers it with a 400 (42b2c49) |
| Path parameters of 101–160 characters, valid in the contract, got the router's 414 in Fastify's own error shape | `status_code_conformance` | `maxParamLength` 256; router rejections (414, malformed URL 400) use the API's error envelope (42b2c49) |
| 413, 414 and 431 were real answers but undocumented | `status_code_conformance` | The OpenAPI document lists them (413 on non-GET, 414 with path parameters, 431 everywhere) (42b2c49) |
| `POST /customization/{sku}/validate` answered 201 where the contract says 200; a scan of every controller found the admin review decision doing the same | `status_code_conformance` | `@HttpCode(200)` on both (16ccca6) |
| A cart of 752 GPUs answered a ₹1.38 crore subtotal, above the ₹1 crore every contract amount is capped at | `response_schema_conformance` | Carts and quotes are refused (400) past ₹1 crore; prices include GST, so that is the order total (ccbd573) |
| The password rule and the Idempotency-Key format lived only in code, so most generated registrations and checkouts were refused | warning: *schema validation mismatch* | Both are patterns in the OpenAPI document now (0696b77); what the warning still lists is data the schema cannot know (a valid TOTP code, a signed quote token, whether a product is personalisable) |

The fuzzer no longer generates NUL bytes (`allow-x00 = false`): the API's 400 for them is pinned by the
regression test instead. Half of the generated slugs and SKUs are seeded products (personalisable mugs for the
customization operations), so 200 responses get their schemas checked too.

### OWASP ZAP baseline

No High alerts on either target in any run. The web app's Medium and Low alerts from the first scans (run
42443522775), and what happened to them; after the fixes (run 42447026147) only the triaged ones are left:

| Alert | Risk | Outcome |
| --- | --- | --- |
| 10024 Sensitive information in URL | Informational | **Fixed.** ZAP submitted the sign-in and registration forms as a browser does before hydration, and they fell back to GET with the email and password in the URL. Every client-handled form now posts (625f5ff); `no-js.spec.ts` guards it |
| 10055 CSP: `style-src 'unsafe-inline'` | Medium | **Fixed.** No page renders an inline style, so `style-src 'self'` (625f5ff) |
| 90004 Cross-Origin-Resource-Policy missing | Low | **Fixed.** Pages send `Cross-Origin-Resource-Policy: same-origin` (625f5ff) |
| 90004 Cross-Origin-Embedder-Policy missing | Low | Triaged (`INFO`): left unset on purpose; `require-corp` or `credentialless` can block gateway frames and CDN images, and nothing needs cross-origin isolation |
| 10202 Absence of anti-CSRF tokens | Medium | Triaged (`IGNORE`): the form is the language switch, a Next.js server action, which Next refuses when the Origin does not match the Host; the search form is a GET |
| 10031, 10111, 10049 | Informational | Triaged (`INFO`): React escapes reflected values; the sign-in form; cache classification |

The API returns only informational cache-classification alerts.

### Other bugs the journeys found

| Bug | Fix |
| --- | --- |
| The admin console's landing page always said "The store is temporarily unavailable": the API never served `GET /api/v1/admin/dashboard`, which the contract and the console use | A read-only admin module composes it from functions each owning module exports (f02d38c); `test/e2e/admin-dashboard.e2e.spec.ts` |
| Right after paying, the order page could say "Awaiting payment" with a "Complete payment" link: the order follows its payment through the outbox | The page re-renders every 2 s, ten times at most, while the order awaits payment, and the status line is a polite live region (f4730c7) |
| After the language switch the document briefly had no `<title>`: Next.js streamed metadata, and the re-rendered page waited on it | `htmlLimitedBots: /.*/` makes metadata blocking for every user agent (9e71607) |

## Known limits

- The ZAP job runs the baseline (spider and passive rules). The plan's active API scan from the OpenAPI
  document (`zap-api-scan.py`) is not wired yet.
- Screenshot baselines exist for desktop Chromium only.
- WebKit and the iPhone project run nightly against plain-HTTP `localhost` with the production cookie settings
  (`Secure`); the first nightly results decide whether anything there needs a change.
