# Scale load profile and zone-failure drill (S5)

> **Status: ready, not yet run.** Both need a real scale deployment on AWS and the owner's approval for the spend
> below. Everything they use is in the repository and checked in CI: `tests/load/scale.js` (validated at 1% against
> the demo API, see [Validation so far](#validation-so-far)) and the FIS template in `deploy/terraform/modules/zone-drill`
> (planned against mocked AWS by `tofu test`). Record the real results in this page when the runs happen.

The milestone's definition of done: **the 10 lakh-user load profile passes, and a zone-failure drill passes.**

## Pass criteria

| Check | Target (plan, scale profile) | Measured by |
| --- | --- | --- |
| Load | 5,000 shopper sessions plus 500 agent sessions, about 1,500 mixed requests/s, a 50 orders/s flash-sale spike | `tests/load/scale.js` scenarios `shoppers`, `agents`, `orders`, `flash_sale` |
| Read latency | p95 < 300 ms | k6 threshold `read_latency` |
| Checkout latency | p95 < 800 ms | k6 threshold `checkout_latency` |
| Agent (MCP) latency | p95 < 800 ms | k6 threshold `agent_latency` |
| Errors | < 0.1% of requests | k6 threshold `http_req_failed` |
| Autoscaling recovers within 5 minutes | read p95 < 300 ms and errors < 0.1% from 5 minutes after the spike ends | k6 thresholds `recovered_read_latency` and `http_req_failed{phase:recovered}`; HPA and Karpenter events |
| Zone failure | the store keeps serving while one zone is down for 10 minutes: errors < 0.1% over the run, the drill's stop alarm (5xx above 1% for 3 minutes) never fires, the database and cache fail over, no order is lost | k6 run during the drill, FIS experiment state `completed` (not `stopped`), RDS events, order count check below |

## Before you start

1. **Approval and budget.** See [Cost](#cost). Agree a window outside business hours.
2. **A scale stack.** `deploy/terraform/profiles/scale` applied with `enable_zone_failure_drill = true` (the template
   costs nothing until started) and the application deployed with `values-scale.yaml` (HPA and Karpenter on).
   `tofu output zone_drill` prints the zone it takes down and the experiment template id.
3. **Load generators in the same region,** outside the cluster: two `c7g.2xlarge` instances (or Grafana Cloud k6)
   with k6 1.8. Put their public IPs in `waf_verified_agent_cidrs` and apply: otherwise the WAF's per-IP limit
   (2,000 requests per 5 minutes) refuses the load as an attack.
4. **Agent credentials.** Create 10 agent clients with `quotaPerMinute: 10000` (admin UI, or
   `POST /api/v1/admin/agent-clients`), mint a token for each with `POST /oauth/token`, and pass them as
   `AGENT_TOKENS=tok1,...,tok10`. Ten tokens keep each under the WAF's per-token limit (60,000 per 5 minutes) and
   the API's per-agent quota.
5. **Stock.** The steady orders (10/s for 15 minutes) and the flash sale (50/s for 2 minutes) place about 15,000
   orders spread over up to 60 SKUs: raise stock first, as the lite benchmark does
   (`UPDATE stock_levels SET on_hand = on_hand + 2000;`, on a test deployment only). `setup()` refuses to start
   without SKUs that show 50+ units.
6. **Observe.** Grafana (or Managed Grafana) dashboards for the API, the HPA (`kubectl get hpa -n <ns> -w`),
   Karpenter (`kubectl get nodeclaims -w`), RDS events and the ALB target health, all open before you start.
7. **Count orders** before the run: `SELECT count(*) FROM orders;`.

## Run 1: load profile

```bash
k6 run -e BASE_URL=https://api.<domain> -e AGENT_TOKENS="$AGENT_TOKENS" \
  --summary-export scale-summary.json tests/load/scale.js
```

15 minutes: steady load from the start, the flash sale from minute 4 to 6, and the recovery window from minute 11.
k6 exits non-zero if any threshold fails. Keep `scale-summary.json`, the HPA and Karpenter events (when replicas
and nodes rose, when latency came back) and the RDS and ElastiCache CPU graphs.

## Run 2: zone-failure drill under load

```bash
k6 run -e BASE_URL=https://api.<domain> -e AGENT_TOKENS="$AGENT_TOKENS" -e DURATION=25m \
  -e SPIKE_AT=15m -e SPIKE_FOR=2m -e RECOVERY=5m --summary-export drill-summary.json tests/load/scale.js &
sleep 180   # steady load first
TEMPLATE=$(tofu -chdir=deploy/terraform/profiles/scale output -json zone_drill | jq -r .experiment_template_id)
aws fis start-experiment --experiment-template-id "$TEMPLATE" --tags Name=zone-drill
aws fis list-experiments --query 'experiments[0].[id,state.status]'   # running -> completed
wait
```

The template takes the chosen zone down for 10 minutes: its public and private subnets lose all connectivity, the
cluster's nodes there stop (and restart after 10 minutes), the database fails over (RDS reboot with forced
failover, or Aurora cluster failover) and the cache's nodes in the zone lose power. The alarm
`<prefix>-zone-drill-abort` stops the experiment if more than 1% of ALB requests fail for three minutes: a stopped
experiment is a failed drill. Afterwards count orders again: the increase must equal k6's successful `order 201`
checks.

To abort by hand: `aws fis stop-experiment --id <experiment id>`. Nodes restart on their own; subnets get their
network ACLs back when the experiment ends.

## After the runs

- Set `enable_zone_failure_drill = false` again (or keep the template; it is free), remove the generator IPs from
  `waf_verified_agent_cidrs`, revoke the load-test agent clients, and stop the generators.
- Write the numbers into [Results](#results): hardware (node types and counts before and after), commit, k6
  summary, recovery time, the failover times from the RDS and ElastiCache events, and the order count check.

## Cost

Estimates, on-demand, ap-south-1, from the Terraform README's scale figures (about $3,000 to $4,000 a month, so
about **$4 to $5.50 an hour**) plus the items the runs add. Check them with the AWS Pricing Calculator or Infracost
before approving.

| Item | Estimate |
| --- | --- |
| Scale stack already running: a 4-hour window (setup, both runs, teardown) | $16 to $22 |
| Scale stack created only for this: about a day including apply and destroy (MSK, OpenSearch and Multi-AZ RDS take up to an hour each way) | $100 to $135 |
| Karpenter or node-group scale-out during the spike (for example 6 extra `m7g.xlarge` for an hour) | about $1 to $2 |
| Two `c7g.2xlarge` load generators for 2 hours | about $1.50 |
| AWS FIS: 4 actions x 10 minutes x $0.10 per action-minute, per drill | about $4 |
| AWS WAF requests (about 1.5 million per run at $0.60 per million) and Bot Control (storefront only, so little of this load) | about $2 |
| ALB capacity units, NAT data processing, CloudWatch | $5 to $15 |
| **Total** | **about $30 to $50 with a running stack; $130 to $170 when the stack exists only for the test** |

## Validation so far

These prove the tooling works; they are **not** scale results.

- **k6 profile at 1%** (2026-11-06, commit `5d88f3f`): `SCALE=0.01` (50 shoppers, 5 agents, 6 orders/min with a
  spike to 30 orders/min), `DURATION=4m SPIKE_AT=60s SPIKE_FOR=60s RECOVERY=60s`, against the demo API (PGlite,
  `DEMO_MODE`, one Node 26 process) on a laptop (Intel Core i5-1345U, 16 GB, Windows 11), k6 1.8.2 on the same
  machine. Every threshold passed: 3,974 requests (16.2/s), 0.00% failed (0 of 966 in the recovered phase), read
  p95 83.5 ms, checkout p95 237 ms, agent (MCP) p95 126 ms, recovered-phase read p95 67.6 ms; 3,002 reads, 708 MCP
  calls (search, quote, offer) and 39 orders, all 3,827 checks green.
- **Zone drill template:** `tofu test` plans it against mocked AWS (actions, zone filters, ARNs, stop alarm, the
  Aurora and self-managed variants, and a zone outside the stack refused); 27 scale tests pass with OpenTofu 1.10.10.

## Results

_Not yet run._
