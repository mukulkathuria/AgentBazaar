variable "name" {
  description = "Name prefix from the naming module. Bucket names are <name>-<account id>-<key> (globally unique)."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for SSE-KMS on every bucket."
  type        = string
}

variable "buckets" {
  description = "Buckets to create with their lifecycle: key => { expire_days, transition_ia_days, noncurrent_expire_days }."
  type = map(object({
    expire_days            = optional(number)
    transition_ia_days     = optional(number)
    noncurrent_expire_days = optional(number, 30)
  }))
  default = {
    media   = {}
    backups = { transition_ia_days = 30, expire_days = 90 }
    logs    = { transition_ia_days = 90, expire_days = 365 }
  }
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete non-empty buckets. Keep false for anything holding real data."
  type        = bool
  default     = false
}

variable "cdn_bucket" {
  description = "Key of the bucket CloudFront reads through Origin Access Control (null: none)."
  type        = string
  default     = null
}

variable "cloudfront_distribution_arn" {
  description = "Distribution allowed to read cdn_bucket."
  type        = string
  default     = null
}

variable "cloudtrail_bucket" {
  description = "Key of the bucket CloudTrail may write to (null: none)."
  type        = string
  default     = null
}
