#!/usr/bin/env bash
# Starts the demo store that the browser, Lighthouse and DAST gates run against: the API on embedded Postgres
# (PGlite) with mock payments and the seeded catalog, then the production (standalone) web build. Build first:
#   pnpm turbo run build --filter=@agentbazaar/api... --filter=@agentbazaar/web...
# The CLI seeds an MFA admin with keys it shares with the server, so the admin journeys can sign in; the
# credentials go to $E2E_STATE_DIR/admin.env and, in GitHub Actions, to $GITHUB_ENV.
# Stop with: kill $(cat "$E2E_STATE_DIR"/*.pid)
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"
STATE="${E2E_STATE_DIR:-${RUNNER_TEMP:-/tmp}/agentbazaar-e2e}"
api_url="http://localhost:$API_PORT"
web_url="http://localhost:$WEB_PORT"
rm -rf "$STATE"
mkdir -p "$STATE"

wait_for() {
  for _ in $(seq 1 120); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  return 1
}

node apps/api/dist/cli/index.js keys > "$STATE/api.env"
cat >> "$STATE/api.env" <<EOF
NODE_ENV=production
DEMO_MODE=true
DATABASE_DRIVER=pglite
PGLITE_DATA_DIR=$STATE/pglite
PORT=$API_PORT
HOST=127.0.0.1
PUBLIC_API_URL=$api_url
PUBLIC_WEB_URL=$web_url
CORS_ORIGINS=$web_url
RATE_LIMIT_PER_MINUTE=100000
LOG_LEVEL=warn
EOF

# Test-only admin on a throwaway database.
admin_password="E2e-$(node -e "process.stdout.write(require('node:crypto').randomBytes(12).toString('base64url'))")"
seeded=$(cd apps/api && node --env-file="$STATE/api.env" dist/cli/index.js seed --admin-email admin@example.com --admin-password "$admin_password")
totp=$(grep -o 'secret=[A-Z2-7]*' <<<"$seeded" | head -n 1 | cut -d= -f2)
if [ -z "$totp" ]; then
  echo "$seeded"
  echo 'seeding printed no admin TOTP secret' >&2
  exit 1
fi
printf 'E2E_ADMIN_EMAIL=admin@example.com\nE2E_ADMIN_PASSWORD=%s\nE2E_ADMIN_TOTP_SECRET=%s\n' "$admin_password" "$totp" > "$STATE/admin.env"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "::add-mask::$admin_password"
  cat "$STATE/admin.env" >> "$GITHUB_ENV"
fi

(cd apps/api && exec node --env-file="$STATE/api.env" dist/main.js > "$STATE/api.log" 2>&1) &
echo $! > "$STATE/api.pid"
wait_for "$api_url/healthz" || { cat "$STATE/api.log"; exit 1; }

# As in apps/web/Dockerfile: the standalone server plus its static assets.
web=apps/web/.next/standalone/apps/web
rm -rf "$web/.next/static"
cp -r apps/web/.next/static "$web/.next/static"
PORT=$WEB_PORT HOSTNAME=127.0.0.1 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_URL=$api_url PUBLIC_API_URL=$api_url \
  PUBLIC_WEB_URL=$web_url node "$web/server.js" > "$STATE/web.log" 2>&1 &
echo $! > "$STATE/web.pid"
wait_for "$web_url/api/health" || { cat "$STATE/web.log"; exit 1; }
echo "Demo store up: web $web_url, API $api_url (logs in $STATE)"
