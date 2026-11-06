# syntax=docker/dockerfile:1.7
# Caddy for the lite edge: the Coraza WAF with the embedded OWASP Core Rule Set and the CrowdSec bouncer.
# All three are Apache-2.0. Build:  docker build -t agentbazaar-caddy deploy/compose/caddy
FROM caddy:2.11.7-builder-alpine AS build
RUN xcaddy build v2.11.7 \
      --with github.com/corazawaf/coraza-caddy/v2@v2.6.2 \
      --with github.com/corazawaf/coraza-coreruleset/v4@v4.25.0 \
      --with github.com/hslatman/caddy-crowdsec-bouncer/http@v0.14.1

FROM caddy:2.11.7-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY waf /etc/caddy/waf
# Fails the build if either module is missing.
RUN caddy list-modules | grep -qx http.handlers.waf && caddy list-modules | grep -qx http.handlers.crowdsec
