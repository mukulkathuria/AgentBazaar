output "experiment_template_id" {
  description = "Start a drill with: aws fis start-experiment --experiment-template-id <this>."
  value       = aws_fis_experiment_template.zone.id
}

output "abort_alarm_name" {
  description = "CloudWatch alarm that stops a running drill."
  value       = aws_cloudwatch_metric_alarm.abort.alarm_name
}
