#!/usr/bin/env bash
# Smoke suite for a cluster install, through the ingress and the APISIX gateway:
#   API_URL=http://api.agentbazaar.test:18080 WEB_URL=http://shop.agentbazaar.test:18080 tests/cluster/smoke.sh
set -euo pipefail
API_URL=${API_URL:?} WEB_URL=${WEB_URL:?}

ok() { echo "ok - $*"; }

curl -fsS "$API_URL/healthz" > /dev/null && ok "api health"
curl -fsS "$API_URL/readyz" > /dev/null && ok "api readiness"
curl -fsS "$WEB_URL/api/health" > /dev/null && ok "web health"
test "$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/")" = 200 && ok "storefront home page"

count=$(curl -fsS "$API_URL/api/v1/products?limit=5" | jq '.items | length')
test "$count" -gt 0 && ok "catalog lists $count products"

# Meilisearch indexes asynchronously after the seed: give it a moment.
for attempt in $(seq 1 30); do
  if curl -fsS "$API_URL/api/v1/products?q=keyboard" | jq -e '[.items[].name] | any(test("keyboard"; "i"))' > /dev/null; then
    ok "search finds keyboards"
    break
  fi
  test "$attempt" -lt 30 || { echo "not ok - search found no keyboard"; exit 1; }
  sleep 2
done

curl -fsS "$API_URL/.well-known/agent-card.json" | jq -e '.name' > /dev/null && ok "agent card"

# The gateway: per-caller rate-limit headers, and bodies over 256 KiB refused before they reach the API.
curl -fsS -D - -o /dev/null "$API_URL/api/v1/products?limit=1" | grep -qi '^x-ratelimit-limit:' && ok "gateway rate-limit headers"
status=$(head -c 300000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- "$API_URL/api/v1/quotes")
test "$status" = 413 && ok "gateway refuses a 300 KB body (413)"
