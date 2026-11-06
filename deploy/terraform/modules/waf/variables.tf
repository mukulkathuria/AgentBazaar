# Defaults live in modules/edge (the waf_* variables); this module validates them.

variable "name" {
  description = "Web ACL name (the naming prefix)."
  type        = string
}

variable "domain_name" {
  description = "Storefront host: Bot Control inspects only requests for it."
  type        = string
}

variable "alb_arn" {
  description = "ALB the web ACL protects."
  type        = string
}

variable "rate_limit" {
  description = "Requests per 5 minutes per client IP before WAF answers 429 (0 disables the rule)."
  type        = number
}

variable "count_only_rules" {
  description = "Core rule set rules switched to count mode."
  type        = list(string)
}

variable "sign_in_rate_limit" {
  description = "Requests per 5 minutes per client IP to /api/v1/auth/login and /oauth/token (0 disables)."
  type        = number

  validation {
    condition     = var.sign_in_rate_limit == 0 || var.sign_in_rate_limit >= 10
    error_message = "AWS WAF rate limits start at 10 (or 0 to disable the rule)."
  }
}

variable "token_rate_limit" {
  description = "Requests per 5 minutes per bearer token (0 disables)."
  type        = number

  validation {
    condition     = var.token_rate_limit == 0 || var.token_rate_limit >= 10
    error_message = "AWS WAF rate limits start at 10 (or 0 to disable the rule)."
  }
}

variable "verified_agent_cidrs" {
  description = "IPv4 CIDRs of verified partner agents."
  type        = list(string)

  validation {
    condition     = alltrue([for c in var.verified_agent_cidrs : can(cidrnetmask(c))])
    error_message = "waf_verified_agent_cidrs takes IPv4 CIDRs such as 203.0.113.0/24 (the ALB listens on IPv4 only)."
  }
}

variable "bot_control_level" {
  description = "Bot Control inspection level: COMMON, TARGETED or null (off)."
  type        = string

  validation {
    condition     = var.bot_control_level == null || contains(["COMMON", "TARGETED"], coalesce(var.bot_control_level, "COMMON"))
    error_message = "waf_bot_control_level must be COMMON, TARGETED or null."
  }
}

variable "bot_control_count_rules" {
  description = "Bot Control rules switched to count."
  type        = list(string)
}

variable "bot_rate_limit" {
  description = "Requests per 5 minutes per unverified bot name and client IP (0 disables)."
  type        = number

  validation {
    condition     = var.bot_rate_limit == 0 || var.bot_rate_limit >= 10
    error_message = "AWS WAF rate limits start at 10 (or 0 to disable the rule)."
  }
}
