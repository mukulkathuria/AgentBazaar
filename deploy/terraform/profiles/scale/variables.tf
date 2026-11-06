# ---------------------------------------------------------------- set by every operator

variable "project_name" {
  description = "Short slug that prefixes every resource name, e.g. agentbazaar."
  type        = string
}

variable "environment" {
  description = "Environment name, e.g. staging or prod (prod turns on deletion protection)."
  type        = string
}

variable "region" {
  description = "AWS region, e.g. ap-south-1."
  type        = string
}

variable "domain_name" {
  description = "Storefront domain (shop.example.com). The API answers on api.<domain>, media on media.<domain>."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a lowercase DNS name such as shop.example.com."
  }
}

variable "profile" {
  description = "Must be \"scale\" for this root module (guards against applying another profile's tfvars here)."
  type        = string
  default     = "scale"

  validation {
    condition     = var.profile == "scale"
    error_message = "This is the scale root module; use profiles/lite or profiles/growth for other profiles."
  }
}

variable "admin_cidrs" {
  description = "CIDRs allowed to reach the EKS API endpoint. Empty: private endpoint only (use a VPN or bastion)."
  type        = list(string)
  default     = []
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD."
  type        = number
  default     = 4000
}

variable "budget_alert_email" {
  description = "Receives budget alerts (and alarm notifications unless alarm_email is set)."
  type        = string
}

# ---------------------------------------------------------------- sizing and options

variable "enable_budget" {
  description = "Create the monthly budget alarm."
  type        = bool
  default     = true
}

variable "route53_zone_name" {
  description = "Public hosted zone containing domain_name (null: a zone named exactly domain_name)."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones (3 for scale; 2 is allowed)."
  type        = number
  default     = 3
}

variable "kubernetes_version" {
  description = "EKS version (null: the EKS default at creation time). Pin it once running."
  type        = string
  default     = null
}

variable "node_instance_types" {
  description = "EKS managed node group instance types (Graviton)."
  type        = list(string)
  default     = ["m7g.xlarge"]
}

variable "node_min" {
  description = "Minimum EKS nodes."
  type        = number
  default     = 3
}

variable "node_desired" {
  description = "Initial EKS nodes."
  type        = number
  default     = 3
}

variable "node_max" {
  description = "Maximum EKS nodes."
  type        = number
  default     = 10
}

variable "eks_admin_role_arns" {
  description = "IAM roles granted cluster-admin (the identity running terraform is admin already)."
  type        = list(string)
  default     = []
}

variable "app_namespace" {
  description = "Kubernetes namespace of the app release."
  type        = string
  default     = "agentbazaar"
}

variable "database_deployment" {
  description = "rds, aurora or self-managed (bring your own Postgres, e.g. CloudNativePG on the cluster)."
  type        = string
  default     = "rds"
}

variable "postgres_major_version" {
  description = "PostgreSQL major version. Null: 18 for RDS/Aurora, 19 for self-managed."
  type        = string
  default     = null
}

variable "db_instance_class" {
  description = "Database instance class."
  type        = string
  default     = "db.r7g.large"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage."
  type        = number
  default     = 200
}

variable "db_multi_az" {
  description = "RDS Multi-AZ standby."
  type        = bool
  default     = true
}

variable "db_read_replicas" {
  description = "Read replicas."
  type        = number
  default     = 1
}

variable "db_backup_retention_days" {
  description = "Automated backup / point-in-time-restore window."
  type        = number
  default     = 14
}

variable "cache_node_type" {
  description = "ElastiCache Valkey node type."
  type        = string
  default     = "cache.r7g.large"
}

variable "cache_replicas" {
  description = "Valkey replicas (above 0 enables Multi-AZ failover)."
  type        = number
  default     = 1
}

variable "cache_engine_version" {
  description = "Valkey engine version."
  type        = string
  default     = "8.1"
}

variable "enable_cdn" {
  description = "Serve media through CloudFront at media.<domain>."
  type        = bool
  default     = true
}

variable "enable_waf" {
  description = "Attach AWS WAF (managed rule groups and a per-IP rate limit) to the ALB."
  type        = bool
  default     = true
}

variable "waf_bot_control_level" {
  description = "AWS WAF Bot Control on the storefront host: COMMON, TARGETED or null (off). Priced per request; see the README."
  type        = string
  default     = "COMMON"
}

variable "waf_verified_agent_cidrs" {
  description = "IPv4 CIDRs of verified partner agents, exempt from the WAF's per-IP rate limit."
  type        = list(string)
  default     = []
}

variable "enable_zone_failure_drill" {
  description = "Create the AWS FIS zone-failure experiment template (free until started; see docs/runbooks/scale-load-and-zone-drill.md)."
  type        = bool
  default     = false
}

variable "zone_drill_az" {
  description = "Availability zone the drill takes down (null: the VPC's first zone)."
  type        = string
  default     = null
}

variable "enable_cloudtrail" {
  description = "Create a multi-region CloudTrail trail."
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Enable GuardDuty in this region."
  type        = bool
  default     = true
}

variable "enable_managed_prometheus" {
  description = "Create an Amazon Managed Service for Prometheus workspace."
  type        = bool
  default     = false
}

variable "enable_managed_grafana" {
  description = "Create an Amazon Managed Grafana workspace (needs IAM Identity Center)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 90
}

variable "alarm_email" {
  description = "Alarm notifications (null: budget_alert_email)."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Override deletion protection (null: on when environment is prod). Set false and apply before destroying a prod stack."
  type        = bool
  default     = null
}

variable "force_destroy_buckets" {
  description = "Let terraform destroy delete non-empty buckets (throwaway environments only)."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "owner/name allowed to deploy through GitHub OIDC (null: no CI role)."
  type        = string
  default     = null
}

variable "github_oidc_subjects" {
  description = "OIDC subjects allowed to assume the CI role (after repo:<owner/name>:)."
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "create_github_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (false if it already exists)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- scale-only

variable "enable_karpenter" {
  description = "Create Karpenter's IAM roles, interruption queue and discovery tags (install the Karpenter chart yourself)."
  type        = bool
  default     = false
}

variable "cache_cluster_mode" {
  description = "Shard Valkey (cluster mode). Needs a cluster-aware client in the API (see the README)."
  type        = bool
  default     = true
}

variable "cache_shards" {
  description = "Valkey shards in cluster mode."
  type        = number
  default     = 2
}

variable "kafka_version" {
  description = "Apache Kafka version on MSK."
  type        = string
  default     = "3.9.x"
}

variable "msk_broker_instance_type" {
  description = "MSK broker instance type."
  type        = string
  default     = "kafka.m7g.large"
}

variable "msk_volume_gb" {
  description = "Storage per MSK broker."
  type        = number
  default     = 100
}

variable "msk_client_broker" {
  description = "Client-broker encryption: TLS, TLS_PLAINTEXT or PLAINTEXT (see the README before relaxing it)."
  type        = string
  default     = "TLS"
}

variable "opensearch_engine_version" {
  description = "OpenSearch engine version."
  type        = string
  default     = "OpenSearch_2.19"
}

variable "opensearch_instance_type" {
  description = "OpenSearch data node instance type."
  type        = string
  default     = "r7g.large.search"
}

variable "opensearch_instance_count" {
  description = "OpenSearch data nodes (a multiple of az_count)."
  type        = number
  default     = 3
}

variable "opensearch_volume_gb" {
  description = "Storage per OpenSearch data node."
  type        = number
  default     = 100
}

variable "opensearch_master_user_arn" {
  description = "IAM principal mapped to the OpenSearch fine-grained-access admin (null: create an admin role)."
  type        = string
  default     = null
}

variable "enable_shield_advanced" {
  description = "Add Shield Advanced protections to the ALB and CDN (requires an active, paid Shield Advanced subscription)."
  type        = bool
  default     = false
}

variable "enable_securityhub" {
  description = "Enable Security Hub with the default standards."
  type        = bool
  default     = true
}

variable "enable_config" {
  description = "Enable the AWS Config recorder (Security Hub needs it for most controls)."
  type        = bool
  default     = true
}

variable "backup_copy_region" {
  description = "Region that receives AWS Backup copies of the database, e.g. ap-southeast-1. Must differ from region."
  type        = string
}

variable "backup_retention_days" {
  description = "Days AWS Backup keeps daily recovery points (in both regions)."
  type        = number
  default     = 35
}

variable "backup_schedule" {
  description = "AWS Backup schedule (cron, UTC)."
  type        = string
  default     = "cron(0 3 * * ? *)"
}
