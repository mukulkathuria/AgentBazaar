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
  description = "Must be \"lite\" for this root module (guards against applying another profile's tfvars here)."
  type        = string
  default     = "lite"

  validation {
    condition     = var.profile == "lite"
    error_message = "This is the lite root module; use profiles/growth or profiles/scale for other profiles."
  }
}

variable "admin_cidrs" {
  description = "CIDRs allowed to SSH to the host. Empty: no SSH at all (Session Manager still works)."
  type        = list(string)
  default     = []
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD."
  type        = number
  default     = 50
}

variable "budget_alert_email" {
  description = "Receives budget alerts (and alarm notifications unless alarm_email is set)."
  type        = string
}

# ---------------------------------------------------------------- optional

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

variable "instance_type" {
  description = "Host instance type (Graviton)."
  type        = string
  default     = "t4g.medium"
}

variable "root_volume_gb" {
  description = "Root volume size."
  type        = number
  default     = 20
}

variable "data_volume_gb" {
  description = "Data volume size (Docker data-root: Postgres and other container volumes)."
  type        = number
  default     = 50
}

variable "ssh_key_name" {
  description = "Optional EC2 key pair name."
  type        = string
  default     = null
}

variable "repo_url" {
  description = "Repository the host clones. Point it at your fork if you run modified code."
  type        = string
  default     = "https://github.com/mukulkathuria/AgentBazaar.git"
}

variable "app_version" {
  description = "Git ref deployed at first boot. Pin a release tag in production."
  type        = string
  default     = "main"
}

variable "compose_file" {
  description = "Compose file (relative to the repository root) whose lite profile runs on the host."
  type        = string
  default     = "deploy/compose/docker-compose.yml"
}

variable "extra_app_env" {
  description = "Extra non-secret variables for the host's .env (merged over the defaults)."
  type        = map(string)
  default     = {}
}

variable "postgres_major_version" {
  description = "PostgreSQL major version expected on the host (self-managed default: 19). Documentation only: the Compose file pins its Postgres image; also written to .env as POSTGRES_MAJOR_VERSION."
  type        = string
  default     = "19"

  validation {
    condition     = can(regex("^[0-9]{2}$", var.postgres_major_version))
    error_message = "postgres_major_version must be a major version such as \"19\"."
  }
}

variable "enable_cdn" {
  description = "Serve media through CloudFront at media.<domain>."
  type        = bool
  default     = false
}

variable "enable_cloudtrail" {
  description = "Create a multi-region CloudTrail trail."
  type        = bool
  default     = false
}

variable "enable_guardduty" {
  description = "Enable GuardDuty in this region."
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
