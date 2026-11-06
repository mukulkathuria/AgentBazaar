# AgentBazaar Helm chart

Deploys the AgentBazaar **api** (port 4000), **web** storefront (port 3000) and, optionally, the **ai**
service (port 8000) on any Kubernetes >= 1.29. Chart `0.9.0`, appVersion `0.9.0`.
The web pods reach the API inside the cluster (`API_URL=http://<fullname>-api:4000`).

What it renders: a Deployment, Service and PodDisruptionBudget per component, HPAs when autoscaling is
on, a ConfigMap of non-secret settings, an Ingress (or AWS TargetGroupBindings), NetworkPolicies
(default deny), an optional ServiceMonitor, and a `pre-install,pre-upgrade` Job that runs
`node dist/cli/index.js migrate` with the api image. Pods run as non-root with a read-only root
filesystem, all capabilities dropped and the RuntimeDefault seccomp profile.

## Install

The chart never creates secrets. Create the Secret first (the default name is `agentbazaar-secrets`):

```bash
kubectl create namespace agentbazaar
kubectl -n agentbazaar create secret generic agentbazaar-secrets \
  --from-literal=DATABASE_URL='postgres://user:pass@host:5432/app?sslmode=require' \
  --from-literal=QUOTE_SIGNING_KEY='...' --from-literal=PII_MASTER_KEY='...' \
  --from-literal=PII_BLIND_INDEX_KEY='...' --from-literal=JWT_PRIVATE_KEY='...'
# On AWS, the stacks keep these in Secrets Manager; sync them with External Secrets Operator, or:
#   aws secretsmanager get-secret-value --secret-id <app_secret_name> --query SecretString --output text \
#     | jq -r 'to_entries[] | "\(.key)=\(.value)"' > app.env
#   kubectl -n agentbazaar create secret generic agentbazaar-secrets --from-env-file=app.env && rm app.env
```

Generate the keys with `pnpm --filter @agentbazaar/api cli keys`.

**Any cluster (lite-style, single replica, Ingress):**

```bash
helm upgrade --install agentbazaar deploy/helm/agentbazaar -n agentbazaar \
  --set config.PUBLIC_WEB_URL=https://shop.example.com \
  --set config.PUBLIC_API_URL=https://api.shop.example.com \
  --set ingress.className=nginx
```

**AWS growth / scale** (after `terraform apply` in `deploy/terraform/profiles/<profile>`; see
`deploy/terraform/README.md` for the AWS Load Balancer Controller and the in-cluster services):

```bash
terraform -chdir=deploy/terraform/profiles/growth output -raw helm_values > tf-values.yaml
helm upgrade --install agentbazaar deploy/helm/agentbazaar -n agentbazaar \
  -f deploy/helm/agentbazaar/values-growth.yaml -f tf-values.yaml     # or values-scale.yaml
```

`tf-values.yaml` carries the public URLs, `VALKEY_URL` (plus `KAFKA_BROKERS` and `OPENSEARCH_URL` on
scale), the ALB target group ARNs and the VPC CIDR for the NetworkPolicy. On EKS the Terraform-managed
ALB (TLS, WAF) forwards to pod IPs through `TargetGroupBinding`s, so the Ingress is off.

## Secret keys

| Key | Needed when |
| --- | --- |
| `DATABASE_URL` | always (`DATABASE_DRIVER=postgres`) |
| `QUOTE_SIGNING_KEY`, `PII_MASTER_KEY`, `PII_BLIND_INDEX_KEY` | always in production (base64, >= 32 bytes) |
| `JWT_PRIVATE_KEY` | `IDENTITY_PROVIDER=builtin` (the default); PEM with `\n` escapes |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | `PAYMENT_ADAPTER=razorpay` |
| `YOUPI_API_KEY`, `YOUPI_WEBHOOK_SECRET` | `PAYMENT_ADAPTER=youpi-pg` |
| `OPENBAO_TOKEN` | secrets adapter `openbao` (growth/scale default) |
| `MEILISEARCH_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_COMPAT_API_KEY`, `SMTP_URL`, `ANALYTICS_INGEST_KEY`, `MOCK_WEBHOOK_SECRET` | when you use that integration |

The authoritative list and the rules per profile live in `packages/config/src/index.ts`.

## Values

| Key | Default | Description |
| --- | --- | --- |
| `existingSecret` | `agentbazaar-secrets` | Secret loaded into every pod and the migration Job (required) |
| `config.*` | lite profile | Non-secret env in a ConfigMap; empty values are omitted so the app uses its `PROFILE` defaults. Any extra key may be added |
| `config.PROFILE` | `lite` | `lite`, `growth` or `scale` |
| `config.PUBLIC_WEB_URL` / `PUBLIC_API_URL` | `https://shop.example.com` / `https://api.shop.example.com` | Public URLs; their hosts are the Ingress hosts (must differ) |
| `config.SEARCH_ADAPTER`, `EVENT_BUS` | `""` | Override the profile's adapters (`postgres`/`meilisearch`/`opensearch`, `inprocess`/`nats`/`kafka`) |
| `config.MEILISEARCH_URL`, `NATS_URL`, `KAFKA_BROKERS`, `OPENSEARCH_URL`, `QDRANT_URL`, `VALKEY_URL`, `OPENBAO_ADDR` | `""` | Service endpoints |
| `config.AI_SERVICE_URL` | `""` | Defaults to the in-chart ai Service when `ai.enabled` |
| `image.tag` | `""` | Image tag for all components (defaults to appVersion) |
| `image.pullPolicy` / `imagePullSecrets` | `IfNotPresent` / `[]` | |
| `serviceAccount.create` / `name` / `annotations` | `true` / `""` / `{}` | Token is not mounted |
| `podSecurityContext` / `securityContext` | non-root uid 1000, read-only root, drop ALL | `<component>.podSecurityContext` is merged on top (ai: uid 10001) |
| `<component>.image.repository` | `ghcr.io/mukulkathuria/agentbazaar-{api,web,ai}` | `<component>` is `api`, `web` or `ai` |
| `<component>.replicaCount` | `1` | Ignored when autoscaling is on |
| `<component>.port` | 4000 / 3000 / 8000 | Container and Service port |
| `<component>.command` | `[]` | Override the image command |
| `<component>.livenessPath` / `readinessPath` | api, ai: `/healthz` / `/readyz`; web: `/api/health` | Startup and liveness use `livenessPath` |
| `<component>.resources` | small requests/limits | |
| `<component>.autoscaling.*` | off; 2–6 replicas at 70% CPU | HPA (autoscaling/v2) |
| `<component>.pdb.enabled` / `maxUnavailable` | `true` / `1` | Never blocks node drains |
| `<component>.writablePaths` | `["/tmp"]` (web adds `/app/apps/web/.next/cache`) | emptyDir mounts on the read-only root filesystem |
| `<component>.extraEnv`, `podAnnotations`, `nodeSelector`, `tolerations`, `affinity` | empty | |
| `<component>.topologySpreadConstraints` | `[]` | The component's `labelSelector` is added unless set |
| `ai.enabled` | `false` | Deploy the ai service |
| `migrations.enabled` | `true` | Hook Job before install/upgrade; api pods then get `SKIP_MIGRATIONS=true` |
| `migrations.command` | `["node","dist/cli/index.js","migrate"]` | |
| `migrations.backoffLimit` / `activeDeadlineSeconds` | `1` / `600` | |
| `ingress.enabled` / `className` / `annotations` | `true` / `""` / `{}` | One Ingress: web host -> web, api host -> api |
| `ingress.tls.enabled` / `secretName` | `true` / `<fullname>-tls` | |
| `targetGroupBindings.enabled` | `false` | AWS Load Balancer Controller bindings to existing target groups |
| `targetGroupBindings.web.targetGroupARN` / `api.targetGroupARN` | `""` | From `terraform output -raw helm_values` |
| `networkPolicy.enabled` | `true` | Default deny ingress; allow `ingressFrom` -> web/api, web -> api, api -> ai |
| `networkPolicy.ingressFrom` | namespace `ingress-nginx` | Peers allowed to reach web and api (VPC CIDR for ALB IP targets) |
| `networkPolicy.metricsFrom` | namespace `monitoring` | Peers allowed to scrape `/metrics` (with `serviceMonitor.enabled`) |
| `serviceMonitor.enabled` / `interval` / `labels` | `false` / `30s` / `{}` | Needs the Prometheus Operator CRDs |

`values-growth.yaml`: `PROFILE=growth`, Meilisearch/NATS/OpenBao endpoints, api and web at 2+ replicas
with HPAs, TargetGroupBindings instead of the Ingress. `values-scale.yaml`: `PROFILE=scale`,
OpenSearch/Kafka/Qdrant, 3+ replicas with HPAs and topology spread across zones (hard) and nodes (soft).

## Notes

- The API serves Prometheus metrics on `/metrics`. The Terraform ALB answers it with 404; with an
  Ingress controller, block that path on the API host yourself.
- Images must exist for your nodes' architecture (Graviton nodes need arm64).
- Check rendering locally: `helm lint deploy/helm/agentbazaar -f deploy/helm/agentbazaar/values-scale.yaml`
  and `helm template agentbazaar deploy/helm/agentbazaar -f deploy/helm/agentbazaar/values-scale.yaml`.
