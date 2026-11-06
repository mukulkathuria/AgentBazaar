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
  description = "Must be \"growth\" for this root module (guards against applying another profile's tfvars here)."
  type        = string
  default     = "growth"

  validation {
    condition     = var.profile == "growth"
    error_message = "This is the growth root module; use profiles/lite or profiles/scale for other profiles."
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
  default     = 400
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
  description = "Availability zones (2 or 3)."
  type        = number
  default     = 2
}

variable "kubernetes_version" {
  description = "EKS version (null: the EKS default at creation time). Pin it once running."
  type        = string
  default     = null
}

variable "node_instance_types" {
  description = "EKS managed node group instance types (Graviton)."
  type        = list(string)
  default     = ["t4g.large"]
}

variable "node_min" {
  description = "Minimum EKS nodes."
  type        = number
  default     = 2
}

variable "node_desired" {
  description = "Initial EKS nodes."
  type        = number
  default     = 2
}

variable "node_max" {
  description = "Maximum EKS nodes."
  type        = number
  default     = 4
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
  default     = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage."
  type        = number
  default     = 50
}

variable "db_multi_az" {
  description = "RDS Multi-AZ standby (off by default in growth)."
  type        = bool
  default     = false
}

variable "db_read_replicas" {
  description = "Read replicas."
  type        = number
  default     = 0
}

variable "db_backup_retention_days" {
  description = "Automated backup / point-in-time-restore window."
  type        = number
  default     = 7
}

variable "cache_node_type" {
  description = "ElastiCache Valkey node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "cache_replicas" {
  description = "Valkey replicas (above 0 enables Multi-AZ failover)."
  type        = number
  default     = 0
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

variable "enable_cloudtrail" {
  description = "Create a multi-region CloudTrail trail."
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Enable GuardDuty in this region."
  type        = bool
  default     = false
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
  default     = 30
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
