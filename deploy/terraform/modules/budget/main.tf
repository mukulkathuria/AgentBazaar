variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "enabled" {
  description = "Create the monthly budget alarm (on by default)."
  type        = bool
  default     = true
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD."
  type        = number

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be greater than 0."
  }
}

variable "alert_emails" {
  description = "Addresses notified at 80% of actual and 100% of forecast spend."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0 && alltrue([for e in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alert_emails needs at least one valid email address."
  }
}

# Account-wide on purpose: it catches spend from anything, not only resources this stack tags.
resource "aws_budgets_budget" "this" {
  count        = var.enabled ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.alert_emails
  }
}

output "budget_name" {
  description = "Budget name, or null when disabled."
  value       = one(aws_budgets_budget.this[*].name)
}
