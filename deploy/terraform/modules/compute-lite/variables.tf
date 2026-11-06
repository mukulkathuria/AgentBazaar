variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "region" {
  description = "AWS region (for the AWS CLI and the awslogs driver on the host)."
  type        = string
}

variable "availability_zone" {
  description = "AZ of subnet_id (the data volume must live in the same AZ)."
  type        = string
}

variable "subnet_id" {
  description = "Public subnet for the host."
  type        = string
}

variable "security_group_ids" {
  description = "Security groups for the host."
  type        = list(string)
}

variable "instance_type" {
  description = "Instance type. Graviton (arm64) by default; the AMI architecture follows the type."
  type        = string
  default     = "t4g.medium"
}

variable "root_volume_gb" {
  description = "Root volume size (OS, Docker engine, the git checkout)."
  type        = number
  default     = 20
}

variable "data_volume_gb" {
  description = "Separate data volume for Docker's data-root (Postgres and other container volumes)."
  type        = number
  default     = 50
}

variable "kms_key_arn" {
  description = "KMS key for both EBS volumes."
  type        = string
}

variable "ssh_key_name" {
  description = "Optional EC2 key pair. SSM Session Manager works without one."
  type        = string
  default     = null
}

variable "termination_protection" {
  description = "Block API termination of the host (on in prod)."
  type        = bool
  default     = false
}

variable "ami_ssm_parameter" {
  description = "Override the SSM parameter that resolves the AMI (default: Ubuntu 24.04 LTS for the instance architecture)."
  type        = string
  default     = null
}

variable "repo_url" {
  description = "Git repository cloned onto the host."
  type        = string
}

variable "app_version" {
  description = "Git ref (tag, branch or commit) deployed at first boot."
  type        = string
}

variable "compose_profile" {
  description = "docker compose profile to start."
  type        = string
  default     = "lite"
}

variable "compose_file" {
  description = "Compose file relative to the repository root."
  type        = string
  default     = "deploy/compose/docker-compose.yml"
}

variable "app_env" {
  description = "Non-secret variables written to the host's .env. Secrets come from app_secret_arn at deploy time."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for v in values(var.app_env) : !strcontains(v, "'") && !strcontains(v, "\n")])
    error_message = "app_env values cannot contain single quotes or newlines (they are written single-quoted to .env)."
  }
}

variable "app_secret_arn" {
  description = "Secrets Manager secret holding the app's secret env as a JSON object."
  type        = string
}

variable "s3_bucket_arns" {
  description = "Buckets the host may read and write (media, backups)."
  type        = list(string)
}

variable "log_group_name" {
  description = "CloudWatch log group for container logs (Docker awslogs driver)."
  type        = string
}

variable "log_group_arn" {
  description = "ARN of log_group_name."
  type        = string
}
