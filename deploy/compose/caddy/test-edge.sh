#!/usr/bin/env bash
# Proves the lite edge against the stack in compose.edge-test.yml: ordinary storefront, API, MCP and A2A traffic
# passes the OWASP CRS, SQL injection, XSS and path traversal get 403, and CrowdSec bans an address that brute-forces
# sign-in while others are still served. Prints one line per check; exits non-zero if any fails.
set -uo pipefail

EDGE=${EDGE_URL:-http://localhost:8090}
HERE=$(cd "$(dirname "$0")" && pwd)
SHOP=shop.test
API=api.shop.test
ATTACKER=203.0.113.77 # documentation ranges: CrowdSec whitelists private addresses, and Caddy trusts the
BYSTANDER=198.51.100.23 # X-Forwarded-For the runner sends through Docker's private bridge
pass=0
fail=0

# code HOST METHOD PATH [curl args...]: the HTTP status only.
code() {
  local host=$1 method=$2 path=$3
  shift 3
  curl -s -o /dev/null -w '%{http_code}' --path-as-is -X "$method" -H "Host: $host" "$@" "$EDGE$path"
}
# body HOST METHOD PATH [curl args...]: the response body only.
body() {
  local host=$1 method=$2 path=$3
  shift 3
  curl -s --path-as-is -X "$method" -H "Host: $host" "$@" "$EDGE$path"
}
# check DESCRIPTION WANT GOT, where WANT is a status or "passes" (anything the WAF did not refuse).
check() {
  local ok=0
  if [ "$2" = passes ]; then
    [ "$3" != 403 ] && [ "$3" != 000 ] && ok=1
  elif [ "$3" = "$2" ]; then
    ok=1
  fi
  if [ $ok = 1 ]; then
    pass=$((pass + 1))
    printf 'PASS  %-66s %s\n' "$1" "$3"
  else
    fail=$((fail + 1))
    printf 'FAIL  %-66s %s (wanted %s)\n' "$1" "$3" "$2"
  fi
}
JSON=(-H 'content-type: application/json')
MCP=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
call() { printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2"; }

echo "== Ordinary traffic passes the WAF"
check "storefront home" passes "$(code $SHOP GET /)"
check "storefront product page with tracking parameters" passes "$(code $SHOP GET '/products/thock-tk87?ref=home&utm_source=chatgpt.com')"
check "storefront search" passes "$(code $SHOP GET '/search?q=mechanical+keyboard+%26+wrist+rest')"
check "storefront Next.js chunk" passes "$(code $SHOP GET /_next/static/chunks/app/page-3f2a9c.js)"
check "storefront image optimizer" passes "$(code $SHOP GET '/_next/image?url=%2Fimages%2Fthock-tk87.webp&w=640&q=75')"
check "storefront llms.txt" passes "$(code $SHOP GET /llms.txt)"
check "API product search" 200 "$(code $API GET '/api/v1/products?q=keyboard')"
check "API search with apostrophes" 200 "$(code $API GET '/api/v1/products?q=rock+%27n%27+roll+mug')"
check "API agent card" 200 "$(code $API GET /.well-known/agent-card.json)"
check "MCP tools/list" 200 "$(code $API POST /mcp "${MCP[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
check "MCP search_products" 200 "$(code $API POST /mcp "${MCP[@]}" -d "$(call search_products '{"query":"mechanical keyboard"}')")"
quote=$(body $API POST /mcp "${MCP[@]}" -d "$(call request_quote '{"sku":"THOCK-TK87-RED","quantity":1}')")
nid=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<< "$quote" | head -1)
check "MCP request_quote opens a negotiation" yes "$([ -n "$nid" ] && echo yes || echo no)"
offer=$(printf '{"negotiation_id":"%s","unit_price_inr":4500,"message":"%s"}' "$nid" "It's my last offer -- I can't go higher; that's 'final' for 2, or is 1=1 a deal?")
check "MCP make_offer with an everyday message (quotes, dashes)" 200 "$(code $API POST /mcp "${MCP[@]}" -d "$(call make_offer "$offer")")"
check "MCP session teardown (DELETE)" passes "$(code $API DELETE /mcp -H 'mcp-session-id: 00000000-0000-0000-0000-000000000000')"
sid=$(body $API POST /api/v1/chat/sessions "${JSON[@]}" -d '{}' | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
chat=$(printf '{"text":"%s"}' "Hi! I'd like to select the red one -- or drop the price to 4,999? What's your union of offers?")
check "chat message with quotes and SQL words" 200 "$(code $API POST "/api/v1/chat/sessions/$sid/messages" "${JSON[@]}" -d "$chat")"
a2a=$(printf '{"jsonrpc":"2.0","id":7,"method":"message/send","params":{"message":{"kind":"message","messageId":"m-1","role":"user","parts":[{"kind":"text","text":"%s"}]}}}' "What's the price of the TK87 -- in INR? I'll take 2.")
check "A2A message/send" passes "$(code $API POST /a2a "${JSON[@]}" -d "$a2a")"
check "payment webhook reaches the API, which checks the signature" 401 "$(code $API POST /api/v1/payments/webhooks/mock "${JSON[@]}" -H "x-mock-signature: $(printf '0%.0s' $(seq 1 64))" -d "{\"event\":\"payment.captured\",\"notes\":\"1' OR '1'='1\"}")"

echo "== Attacks get 403"
check "SQL injection in a query string" 403 "$(code $API GET '/api/v1/products?q=1%27%20UNION%20SELECT%20password%20FROM%20users--')"
check "SQL injection in an MCP tool argument" 403 "$(code $API POST /mcp "${MCP[@]}" -d "$(call search_products "{\"query\":\"x' OR 1=1 -- \"}")")"
check "XSS in the storefront search" 403 "$(code $SHOP GET '/search?q=%3Cscript%3Ealert(document.cookie)%3C/script%3E')"
check "XSS in chat text" 403 "$(code $API POST "/api/v1/chat/sessions/$sid/messages" "${JSON[@]}" -d '{"text":"<script>alert(document.cookie)</script>"}')"
check "path traversal in the path" 403 "$(code $SHOP GET '/assets/..%2f..%2f..%2fetc%2fpasswd')"
check "path traversal in a parameter" 403 "$(code $API GET '/api/v1/products?file=../../../../etc/passwd')"

echo "== CrowdSec bans a brute-force source"
for i in $(seq 1 12); do
  code $API POST /api/v1/auth/login "${JSON[@]}" -H "X-Forwarded-For: $ATTACKER" \
    -d "{\"email\":\"buyer$i@example.com\",\"password\":\"wrong-password-$i\"}" > /dev/null
done
seen=000
for _ in $(seq 1 45); do
  seen=$(code $API GET '/api/v1/products?q=mug' -H "X-Forwarded-For: $ATTACKER")
  [ "$seen" = 403 ] && break
  sleep 2
done
check "brute-force source refused at the edge" 403 "$seen"
check "another address is still served" 200 "$(code $API GET '/api/v1/products?q=mug' -H "X-Forwarded-For: $BYSTANDER")"
decisions=$(docker compose -f "$HERE/compose.edge-test.yml" exec -T crowdsec cscli decisions list -o json 2> /dev/null)
check "CrowdSec decision comes from agentbazaar/sign-in-bf" yes "$(grep -q 'agentbazaar/sign-in-bf' <<< "$decisions" && grep -q "$ATTACKER" <<< "$decisions" && echo yes || echo no)"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
