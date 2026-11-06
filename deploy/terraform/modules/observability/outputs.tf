output "log_group_names" {
  description = "Log group names by key."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.name }
}

output "log_group_arns" {
  description = "Log group ARNs by key."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.arn }
}

output "alarm_topic_arn" {
  description = "SNS topic every alarm notifies."
  value       = aws_sns_topic.alarms.arn
}

output "prometheus_endpoint" {
  description = "Managed Prometheus remote-write/query endpoint, or null."
  value       = one(aws_prometheus_workspace.this[*].prometheus_endpoint)
}

output "grafana_endpoint" {
  description = "Managed Grafana URL, or null."
  value       = one(aws_grafana_workspace.this[*].endpoint)
}
