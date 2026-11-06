variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for log groups and the alarm topic."
  type        = string
}

variable "log_groups" {
  description = "Log groups to create as /<name>/<entry>."
  type        = list(string)
  default     = ["app"]
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Email subscribed to the alarm topic (null: none; confirm the subscription email)."
  type        = string
  default     = null
}

variable "alarms" {
  description = "CloudWatch metric alarms: key => metric definition. They notify the alarm topic."
  type = map(object({
    namespace           = string
    metric_name         = string
    dimensions          = map(string)
    threshold           = number
    statistic           = optional(string, "Average")
    comparison_operator = optional(string, "GreaterThanThreshold")
    period              = optional(number, 300)
    evaluation_periods  = optional(number, 3)
    treat_missing_data  = optional(string, "notBreaching")
    description         = optional(string, "")
  }))
  default = {}
}

variable "enable_managed_prometheus" {
  description = "Create an Amazon Managed Service for Prometheus workspace."
  type        = bool
  default     = false
}

variable "enable_managed_grafana" {
  description = "Create an Amazon Managed Grafana workspace (needs IAM Identity Center in the account)."
  type        = bool
  default     = false
}
