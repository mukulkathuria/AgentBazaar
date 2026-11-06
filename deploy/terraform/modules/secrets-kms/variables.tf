variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "region" {
  description = "Region of the key (CloudWatch Logs uses a regional service principal)."
  type        = string
}

variable "secret_prefix" {
  description = "Secrets Manager path prefix, e.g. <project>/<environment>."
  type        = string
}

variable "secrets" {
  description = "Secret placeholders to create: name => description. Values are set by the operator, never in code."
  type        = map(string)
  default     = {}
}

variable "deletion_window_days" {
  description = "Waiting period before a scheduled key deletion completes."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_days >= 7 && var.deletion_window_days <= 30
    error_message = "deletion_window_days must be between 7 and 30."
  }
}

variable "secret_recovery_days" {
  description = "Recovery window for deleted secrets."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_days >= 7 && var.secret_recovery_days <= 30
    error_message = "secret_recovery_days must be between 7 and 30."
  }
}

variable "allow_cloudtrail" {
  description = "Let CloudTrail encrypt trail files with this key."
  type        = bool
  default     = false
}

variable "allow_cloudfront" {
  description = "Let CloudFront (this account's distributions) decrypt objects, for SSE-KMS media served through OAC."
  type        = bool
  default     = false
}
