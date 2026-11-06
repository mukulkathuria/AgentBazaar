# Deploy on AWS

Terraform/OpenTofu code that deploys AgentBazaar into **your** AWS account under **your** names. Nothing
here is tied to the maintainers' account, region or domain: every name derives from `project_name`,
`environment` and the region, and every resource is tagged `Project`, `Environment`, `Profile`,
`ManagedBy=terraform` through the provider's `default_tags`.

| Profile | What you get | Rough cost |
| --- | --- | --- |
| **lite** | One Graviton EC2 host (t4g.medium, encrypted gp3, Elastic IP, IMDSv2) running the Docker Compose stack (Postgres inside Compose), S3 media/backups/logs, Route 53, optional CloudFront, Secrets Manager, CloudWatch, budget alarm. **No NAT gateway.** Ports 80/443 open, 22 only from `admin_cidrs`. | ~$30–45/month |
| **growth** | EKS (managed Graviton nodes), RDS PostgreSQL (Multi-AZ off by default), ElastiCache Valkey, ALB + AWS WAF, S3 + CloudFront, CloudTrail, optional Managed Prometheus/Grafana. Meilisearch, NATS and OpenBao run on the cluster via Helm. | ~$300–400/month |
| **scale** | Multi-AZ EKS (Karpenter flag), RDS or Aurora PostgreSQL Multi-AZ with read replicas, ElastiCache cluster mode, MSK, OpenSearch (3 AZs), WAF (Shield Advanced flag), GuardDuty, Security Hub, AWS Config, AWS Backup with a cross-region copy. Qdrant and Temporal run on the cluster via Helm. | ~$3,000–4,000/month |

Costs are **estimates only** (see [Cost estimates](#cost-estimates)); check them with Infracost before applying.

```
deploy/terraform/
  modules/    naming network compute-lite eks database cache search streaming storage
              edge secrets-kms security observability ci-oidc budget
  profiles/   lite/ growth/ scale/   root modules (+ backend.tf.example, tests/)
  examples/   lite.tfvars growth.tfvars scale.tfvars   placeholder values
```

## Prerequisites

- An AWS account and credentials for an administrator-level role (only for `apply`; tests need none).
- Terraform >= 1.10 or OpenTofu >= 1.10.
- A **public Route 53 hosted zone** for your domain (or a parent zone, see `route53_zone_name`) whose
  name servers your registrar delegates to. ACM validates certificates through it.
- AWS CLI v2; for growth/scale also `kubectl` and `helm` (v3.14+ or v4).
- Container images published for **arm64** (hosts and nodes are Graviton by default): `ghcr.io/<owner>/agentbazaar-{api,web,ai}`.

## State bootstrap

Remote state lives in an S3 bucket you create once per account, outside these stacks:

```bash
REGION=ap-south-1                      # where the state bucket lives
BUCKET=<project>-tfstate-<account-id>  # globally unique
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"   # omit this flag in us-east-1
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Then, in the profile you deploy:

```bash
cd deploy/terraform/profiles/<lite|growth|scale>
cp backend.tf.example backend.tf     # set bucket, key and region
terraform init
```

`backend.tf.example` uses **S3-native locking** (`use_lockfile = true`, Terraform/OpenTofu >= 1.10).
If you still lock with DynamoDB, create a table with a `LockID` string hash key
(`aws dynamodb create-table --table-name <lock-table> --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST`)
and set `dynamodb_table` instead. Use one state key per profile and environment.
`backend.tf`, `*.auto.tfvars` and lock files are git-ignored here; commit them in your own deployment repository.

## Configure

Copy `examples/<profile>.tfvars`, replace every placeholder, and keep the file outside this repository
(it holds no secrets, only names and emails). Everyone sets:

| Variable | Meaning |
| --- | --- |
| `project_name` | 2–20 chars, lowercase; prefixes every name (`<project>-<env>-<region code>`, e.g. `agentbazaar-staging-aps1`) |
| `environment` | e.g. `staging`, `prod`. `prod` turns on deletion protection, termination protection and final snapshots |
| `region` | e.g. `ap-south-1` |
| `domain_name` | storefront host, e.g. `shop.example.com`; the API is served on `api.<domain>`, media on `media.<domain>` |
| `profile` | must match the root module you apply (guards against applying the wrong tfvars) |
| `admin_cidrs` | lite: SSH sources; growth/scale: who may reach the EKS API endpoint (empty = private only) |
| `monthly_budget_usd`, `budget_alert_email` | AWS Budgets alarm at 80% actual / 100% forecast (on by default) |
| `postgres_major_version` | lite: `"19"` (documents the Compose Postgres); growth/scale: `null` means 18 for RDS/Aurora, 19 for `database_deployment = "self-managed"` |

Sizing overrides (instance types, node counts, database class, cache/search/Kafka sizes) are listed in
each profile's `variables.tf` with their defaults. Secrets never go in variables: the stacks create
**empty** Secrets Manager placeholders and you put the values in.

## Apply

All commands run from `deploy/terraform/profiles/<profile>` with credentials for the target account.

### Lite

```bash
terraform init
terraform apply -var-file=/path/to/lite.tfvars
# The host boots, installs Docker + the compose plugin, clones repo_url at app_version and waits
# (up to an hour) for the app secret, then runs
#   docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite up -d --build
aws secretsmanager put-secret-value --secret-id "$(terraform output -raw app_secret_name)" \
  --secret-string file://app-secrets.json
# app-secrets.json: {"POSTGRES_PASSWORD": "...", "QUOTE_SIGNING_KEY": "...", "PII_MASTER_KEY": "...",
#   "PII_BLIND_INDEX_KEY": "...", "JWT_PRIVATE_KEY": "...", plus your payment keys}
# Generate the app keys with `pnpm --filter @agentbazaar/api cli keys`.
$(terraform output -raw shell_command)       # then: sudo tail -f /var/log/agentbazaar-bootstrap.log
```

Terraform renders the non-secret half of the host's `.env` (`PROFILE`, `PUBLIC_*_URL`, `CORS_ORIGINS`,
`SITE_DOMAIN`, `API_DOMAIN`, plus `extra_app_env`); the deploy script appends the secret half from
Secrets Manager on every deploy. DNS for `domain_name` and `api.<domain>` points at the Elastic IP,
and the Compose stack's Caddy obtains certificates over ports 80/443. Docker's data-root lives on a
separate encrypted EBS volume, so Postgres data survives instance replacement, and destroying the
volume leaves a final snapshot. Upgrade in place, from a laptop or CI:

```bash
terraform output -raw deploy_command   # aws ssm send-command ... 'agentbazaar-deploy <git-ref>'
```

The bootstrap runs once: changing `app_version` or the AMI does **not** replace the host (both are
ignored after creation), so use `agentbazaar-deploy` for upgrades.

### Growth

```bash
terraform init && terraform apply -var-file=/path/to/growth.tfvars        # ~25 minutes
$(terraform output -raw kubeconfig_command)
kubectl create namespace agentbazaar

# 1. AWS Load Balancer Controller (its Pod Identity role already exists): registers pods into the
#    Terraform-managed ALB target groups through TargetGroupBinding.
helm repo add eks https://aws.github.io/eks-charts
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName="$(terraform output -raw cluster_name)" --set serviceAccount.name=aws-load-balancer-controller

# 2. An encrypted gp3 StorageClass for in-cluster state (Meilisearch, NATS, OpenBao).
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: ebs.csi.aws.com
parameters: { type: gp3, encrypted: "true", kmsKeyId: "$(terraform output -raw kms_key_arn)" }
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF

# 3. In-cluster services, named as values-growth.yaml expects (meilisearch, nats, openbao).
helm repo add meilisearch https://meilisearch.github.io/meilisearch-kubernetes
helm repo add nats https://nats-io.github.io/k8s/helm/charts
helm repo add openbao https://openbao.github.io/openbao-helm
helm upgrade --install meilisearch meilisearch/meilisearch -n agentbazaar
helm upgrade --install nats nats/nats -n agentbazaar --set config.jetstream.enabled=true
helm upgrade --install openbao openbao/openbao -n agentbazaar     # initialise and unseal it per OpenBao's docs

# 4. Database role, then the app Secret, then the app (see deploy/helm/agentbazaar/README.md).
```

**DATABASE_URL.** RDS keeps the master password in Secrets Manager (`terraform output database`,
`master_user_secret_arn`) and **rotates it every 7 days**, so do not hand it to the app. Use it once,
from a pod in the cluster (`psql` as `app_admin`), to create an application role and the extensions the
migrations need (on RDS only the master user may create `vector`):

```sql
CREATE ROLE agentbazaar LOGIN PASSWORD '<strong password>';
GRANT agentbazaar TO app_admin;            -- lets the master user hand over ownership
ALTER DATABASE app OWNER TO agentbazaar;   -- PostgreSQL 15+: the owner also owns schema public
\c app
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Then put `postgres://agentbazaar:<password>@<endpoint>:5432/app?sslmode=...` into the app secret. TLS is enforced
(`rds.force_ssl=1`): node-postgres treats `sslmode=require` as `verify-full`, so either mount the
[RDS CA bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) and add `sslrootcert=`,
or use `sslmode=no-verify` (encrypted, server not verified).

### Scale

As growth, plus:

- `backup_copy_region` is required (AWS Backup copies the database there daily).
- `enable_karpenter = true` creates Karpenter's controller role (Pod Identity, `kube-system/karpenter`),
  node role, interruption queue and discovery tags. Install the chart yourself with the values from
  `terraform output karpenter` (`settings.clusterName`, `settings.interruptionQueue`), and give your
  `EC2NodeClass` the node role and `karpenter.sh/discovery: <cluster name>` selectors.
- Install Qdrant (release `qdrant`), Temporal and OpenBao on the cluster; `values-scale.yaml` expects
  `http://qdrant:6333` and `http://openbao:8200`.
- GuardDuty, Security Hub and AWS Config are account/region singletons. If your organisation manages them
  centrally, set `enable_guardduty`, `enable_securityhub` and `enable_config` to `false`.
- `enable_shield_advanced = true` only adds protections; the Shield Advanced subscription itself is a
  paid annual commitment you start in the console.

### CI (GitHub OIDC)

Set `github_repository = "<owner>/<repo>"` (and `github_oidc_subjects`, default `ref:refs/heads/main`)
to create a role GitHub Actions assumes without long-lived keys (`terraform output -raw ci_role_arn`):
lite may only run `agentbazaar-deploy` on the host through SSM; growth/scale may only describe the
cluster and edit the app namespace (EKS access entry). Set `create_github_oidc_provider = false` if the
account already has the `token.actions.githubusercontent.com` provider.

## Teardown

```bash
helm uninstall agentbazaar -n agentbazaar          # growth/scale: app first (target groups drain)
kubectl delete pvc --all -n agentbazaar             # EBS volumes made by the CSI driver are not in Terraform
# prod stacks: turn protection off first
terraform apply -var-file=... -var deletion_protection=false -var force_destroy_buckets=true
terraform destroy -var-file=... -var deletion_protection=false -var force_destroy_buckets=true
```

What stays behind on purpose:

- **Final snapshots**: the lite data volume always; RDS/Aurora when protection was on (`<prefix>-pg-final`;
  delete it before re-creating a stack with the same name).
- **Secrets** wait out their recovery window (7 days, 30 in prod) and keep their names until then
  (`aws secretsmanager delete-secret --force-delete-without-recovery` to free a name now).
- **KMS keys** are scheduled for deletion after 30 days.
- **AWS Backup recovery points** (scale): delete them in both vaults before the vaults can go.
- Account-level services (GuardDuty, Security Hub, AWS Config) are disabled when their resources are destroyed.

## Cost estimates

Rough **on-demand** monthly figures for a small shop with light traffic, before free tier and
discounts, excluding data transfer and request-driven charges. They are estimates to be checked with
[Infracost](https://www.infracost.io/) for your region and sizing, not quotes:

```bash
infracost breakdown --path deploy/terraform/profiles/growth --terraform-var-file ../../examples/growth.tfvars
```

| Item | lite | growth | scale |
| --- | --- | --- | --- |
| Compute | t4g.medium host ~$16–25 | EKS control plane ~$73 + 2× t4g.large ~$65–100 | EKS ~$73 + 3× m7g.xlarge ~$300–360 |
| Storage / EBS | ~$6 | ~$10 | ~$30 |
| Networking | Elastic IP ~$4 | NAT ~$35–45, ALB ~$25, public IPv4 ~$11 | 3× NAT ~$100–130, ALB ~$40 |
| Edge security | – | WAF ~$10–15 | WAF ~$15–30 (+ Shield Advanced if enabled) |
| PostgreSQL | in Compose | RDS db.t4g.medium single-AZ ~$55–65 | RDS db.r7g.large Multi-AZ + 1 replica ~$550–600 |
| Cache | in Compose | Valkey cache.t4g.small ~$25 | 4× cache.r7g.large ~$600–650 |
| Search / streaming | in Compose | on the cluster | OpenSearch ~$650–700, MSK ~$450–500 |
| Security / backup | – | CloudTrail ~$0–5 | GuardDuty, Security Hub, Config ~$50–200; AWS Backup + copy ~$30–100 |
| S3, CloudFront, CloudWatch, KMS, Secrets | ~$5–10 | ~$25–50 | ~$100–250 |
| **Total (estimate)** | **~$30–45** | **~$300–400** | **~$3,000–4,000** |

## Disaster recovery

- **lite**: the database lives on the host's data volume (separate from the instance, encrypted, final
  snapshot on destroy). Schedule `pg_dump` from the Compose stack to the `backups` bucket (the host role
  can write to it) and consider EBS snapshots (Data Lifecycle Manager or AWS Backup). Recovery: re-apply,
  restore the latest dump. RPO is your dump interval.
- **growth**: RDS automated backups with point-in-time restore for `db_backup_retention_days` (7);
  versioned, KMS-encrypted buckets; Multi-AZ is off by default (`db_multi_az = true` for a standby).
  Recovery: `aws rds restore-db-instance-to-point-in-time`, then point `DATABASE_URL` at the new endpoint.
- **scale**: Multi-AZ primary plus read replicas, PITR for 14 days, and AWS Backup daily recovery points
  copied to `backup_copy_region` (35 days). For a regional outage, restore the database from the copy
  vault in the second region and apply the same profile there; names embed the region code, so the two
  stacks never collide. Media buckets are versioned but not replicated: add S3 Cross-Region Replication
  if media must survive a regional loss.
- Test restores on a schedule; a backup you have not restored is a hope, not a backup.

## PostgreSQL 19

`postgres_major_version` defaults to **18** for managed services (RDS/Aurora) and **19** for self-managed
hosts (lite's Compose stack, or `database_deployment = "self-managed"` where you run Postgres yourself,
e.g. CloudNativePG). Managed services usually lag community releases by months: until AWS offers 19,
an RDS/Aurora apply with `"19"` fails at the API (no engine version, no `postgres19` parameter group
family). Check availability with
`aws rds describe-db-engine-versions --engine postgres --query "DBEngineVersions[?starts_with(EngineVersion,'19')].EngineVersion"`.
The app detects SQL/PGQ (property graph queries, new in 19) at startup and falls back to plain joins on
18, so both versions are supported. Major upgrades: change `postgres_major_version`, snapshot, and apply in
a maintenance window (`allow_major_version_upgrade` is on; the versioned parameter group is created before
the old one is removed).

## Security defaults

- KMS (customer-managed, rotation on) for S3, EBS, RDS/Aurora, ElastiCache, OpenSearch, MSK, Secrets
  Manager, CloudWatch Logs, SNS, EKS secrets and CloudTrail. Key policies name their actions.
- Databases, caches, search and Kafka live in private subnets with security groups that only admit the
  app (EKS cluster security group); none is publicly accessible.
- S3: public access blocked, versioning, SSE-KMS, TLS-only bucket policies, lifecycle rules.
- IAM: no wildcard actions in any Allow statement (enforced by tests and by `ci-oidc` input validation);
  CI uses GitHub OIDC, never long-lived keys.
- IMDSv2 required on the lite host (hop limit 1) and on EKS nodes (`node_metadata_hop_limit`, default 2 so
  add-ons can discover their region; set 1 to hide node credentials from pods).
- ALB: TLS 1.2+ policy, HTTP→HTTPS redirect, invalid headers dropped, `/metrics` answered with 404, WAF
  with the AWS Core rule set, Known bad inputs, IP reputation and a per-IP rate limit
  (`SizeRestrictions_BODY` counts instead of blocking: API bodies may exceed 8 KB).
- WAF bot management (`modules/waf`): rate rules on the sign-in endpoints and per bearer token besides per IP,
  all answering 429; on scale, AWS WAF Bot Control (`waf_bot_control_level`, default `COMMON`, about $10 a month
  plus $1 per million inspected requests) on the storefront host only, with AI crawlers and HTTP-library clients
  counted and throttled per bot instead of blocked, since agents are customers; `waf_verified_agent_cidrs` exempts
  partner agents' IPv4 ranges from the per-IP limit.
- Zone-failure drill (scale, `enable_zone_failure_drill`, off by default): an AWS FIS template that takes one zone
  down for ten minutes with a 1% 5xx stop alarm; see `docs/runbooks/scale-load-and-zone-drill.md`.
- Deletion protection, termination protection and final snapshots when `environment = "prod"`
  (override with `deletion_protection`).

## Validate without AWS

Every check runs offline against `mock_provider "aws"`: no credentials, no API calls.

```bash
terraform fmt -check -recursive deploy/terraform
for p in lite growth scale; do
  terraform -chdir=deploy/terraform/profiles/$p init -backend=false
  terraform -chdir=deploy/terraform/profiles/$p validate
  terraform -chdir=deploy/terraform/profiles/$p test
done
```

`tofu` accepts the same commands. Each profile's `tests/` holds a profile file (plans the root module:
naming follows `project_name`, tags, budget on by default, NAT count, PostgreSQL 18 and 19 with the
matching parameter group family, WAF managed rule groups, profile guard) and a `policies.tftest.hcl`
that plans modules directly (private and encrypted databases, S3 public access block/versioning/
SSE-KMS/TLS-only, no wildcard IAM actions, IMDSv2, encryption at rest and in transit). CI (`.github/workflows/iac.yml`) runs these
with OpenTofu, plus TFLint (`.tflint.hcl`), Checkov (report-only, SARIF to code scanning) and
`helm lint`/`helm template`. Locally, `checkov -d deploy` or `trivy config deploy` give the same
advisory scan.

## Known gaps between this infrastructure and the current app

These are app-side follow-ups; the infrastructure keeps the secure setting and offers a switch.

- **Valkey cluster mode (scale)**: the API's Valkey adapter (`apps/api/src/shared/cache/valkey-cache.ts`)
  uses a standalone client, which cannot follow cluster redirects. Set `cache_cluster_mode = false`
  until it uses a cluster-aware client.
- **MSK TLS (scale)**: the Kafka adapter (`apps/api/src/shared/outbox/broker-bus.ts`) connects without TLS,
  while MSK defaults to TLS-only. Until the adapter enables TLS, set `msk_client_broker = "TLS_PLAINTEXT"`;
  `kafka_brokers` and `helm_values` then hand the app the plaintext listener.
- **OpenSearch (scale)** has fine-grained access control with IAM: requests must be SigV4-signed by an IAM
  principal mapped in OpenSearch security (e.g. a Pod Identity role for the API). The admin role is
  `terraform output opensearch_admin_role_arn`.
- **Lite Postgres version**: `deploy/compose/docker-compose.yml` pins `pgvector/pgvector:pg18`, while
  `postgres_major_version` documents 19 for self-managed hosts. Parameterise the image
  (`pgvector/pgvector:pg${POSTGRES_MAJOR_VERSION:-18}`; Terraform already writes that variable to `.env`)
  to make the setting take effect.
- **Migrations**: the Helm hook runs `node dist/cli/index.js migrate` in the API image.
