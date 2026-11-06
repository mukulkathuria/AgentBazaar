variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "deployment" {
  description = "rds (RDS for PostgreSQL), aurora (Aurora PostgreSQL) or self-managed (Terraform creates no database; you run Postgres yourself)."
  type        = string
  default     = "rds"

  validation {
    condition     = contains(["rds", "aurora", "self-managed"], var.deployment)
    error_message = "deployment must be rds, aurora or self-managed."
  }
}

variable "postgres_major_version" {
  description = "PostgreSQL major version; the parameter group family follows it (postgres<N> / aurora-postgresql<N>)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{2}$", var.postgres_major_version)) ? tonumber(var.postgres_major_version) >= 16 : false
    error_message = "postgres_major_version must be a major version of 16 or later, e.g. \"18\"."
  }
}

variable "instance_class" {
  description = "Instance class (Graviton by default)."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage_gb" {
  description = "Initial storage (RDS only)."
  type        = number
  default     = 50
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling (RDS only)."
  type        = number
  default     = 200
}

variable "multi_az" {
  description = "Standby in a second AZ (RDS). Aurora gets HA from read_replicas spread across AZs."
  type        = bool
  default     = false
}

variable "read_replicas" {
  description = "Number of read replicas (RDS replicas or extra Aurora instances)."
  type        = number
  default     = 0

  validation {
    condition     = var.read_replicas >= 0 && var.read_replicas <= 5
    error_message = "read_replicas must be between 0 and 5."
  }
}

variable "backup_retention_days" {
  description = "Automated backup retention; point-in-time restore covers this window."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 1 and 35 (0 would disable PITR)."
  }
}

variable "deletion_protection" {
  description = "Deletion protection plus a final snapshot on destroy (on in prod)."
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  description = "KMS key for storage, the managed master secret and log exports."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the database."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets only; the database is never publicly accessible."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect on 5432."
  type        = list(string)
  default     = []
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "app"
}

variable "username" {
  description = "Master username. RDS generates and rotates the password in Secrets Manager."
  type        = string
  default     = "app_admin"
}

variable "log_retention_days" {
  description = "Retention of the exported PostgreSQL logs."
  type        = number
  default     = 30
}

variable "apply_immediately" {
  description = "Apply modifications now instead of in the maintenance window."
  type        = bool
  default     = false
}
