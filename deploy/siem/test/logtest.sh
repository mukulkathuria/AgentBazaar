#!/usr/bin/env bash
# Runs deploy/siem's decoders and rules through wazuh-logtest in a pinned wazuh-manager container, once with the
# lines as syslog messages (the shipping path) and once as plain JSON (a Wazuh agent reading a JSON file), and
# checks that every expected rule fires. Needs Docker and about 1.5 GB of memory; removes its container on exit.
#   deploy/siem/test/logtest.sh [samples.jsonl]   (default: deploy/siem/samples/agentbazaar-api.jsonl)
set -euo pipefail

IMAGE=wazuh/wazuh-manager:4.14.8
SIEM=$(cd "$(dirname "$0")/.." && pwd)
SAMPLES=${1:-$SIEM/samples/agentbazaar-api.jsonl}
NAME=agentbazaar-logtest-$$
# Rules the samples must trigger (README.md lists what each one means). 100232 and 100251 need more events.
EXPECTED="100210 100211 100212 100213 100215 100216 100220 100221 100230 100231 100240 100241 100245 100246 100250 100252 100253 100254"
NORMAL='{"level":30,"time":1793961455000,"service":"agentbazaar-api","profile":"scale","port":4000,"msg":"AgentBazaar API listening"}'

docker run -d --name "$NAME" "$IMAGE" > /dev/null
trap 'docker rm -f "$NAME" > /dev/null' EXIT

wait_for_logtest() {
  for _ in $(seq 1 120); do
    docker exec "$NAME" test -S /var/ossec/queue/sockets/logtest 2> /dev/null && return 0
    sleep 2
  done
  echo "wazuh-logtest never came up" >&2
  docker logs --tail 50 "$NAME" >&2
  return 1
}

wait_for_logtest
docker cp "$SIEM/wazuh/decoders/agentbazaar_decoders.xml" "$NAME:/var/ossec/etc/decoders/agentbazaar_decoders.xml"
docker cp "$SIEM/wazuh/rules/agentbazaar_rules.xml" "$NAME:/var/ossec/etc/rules/agentbazaar_rules.xml"
docker exec "$NAME" chown root:wazuh /var/ossec/etc/decoders/agentbazaar_decoders.xml /var/ossec/etc/rules/agentbazaar_rules.xml
docker exec "$NAME" rm -f /var/ossec/queue/sockets/logtest
docker exec "$NAME" /var/ossec/bin/wazuh-control restart > /dev/null
wait_for_logtest

failed=0
for mode in syslog json; do
  if [ "$mode" = syslog ]; then
    input=$( (echo "$NORMAL"; cat "$SAMPLES") | sed 's/^/Nov  6 10:00:00 shop agentbazaar-api: /')
    base=100200
  else
    input=$( (echo "$NORMAL"; cat "$SAMPLES") )
    base=100201
  fi
  out=$(printf '%s\n' "$input" | docker exec -i "$NAME" /var/ossec/bin/wazuh-logtest 2>&1)
  fired=$(grep -oE "id: '[0-9]+'" <<< "$out" | grep -oE '[0-9]+' | sort -u | tr '\n' ' ')
  first=$(grep -oE "id: '[0-9]+'" <<< "$out" | head -1 | grep -oE '[0-9]+')
  echo "[$mode] rules fired: $fired"
  if [ "$first" != "$base" ]; then
    echo "[$mode] FAIL: an ordinary API line should only reach the base rule $base, got $first" >&2
    failed=1
  fi
  for id in $EXPECTED; do
    if ! grep -qw "$id" <<< "$fired"; then
      echo "[$mode] FAIL: rule $id did not fire" >&2
      failed=1
    fi
  done
  if [ "$failed" = 1 ]; then echo "$out" | tail -80 >&2; fi
done

[ "$failed" = 0 ] && echo "wazuh-logtest: every expected rule fired in both modes"
exit "$failed"
