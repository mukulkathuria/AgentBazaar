output "web_url" {
  description = "Storefront URL."
  value       = module.edge.web_url
}

output "api_url" {
  description = "API URL."
  value       = module.edge.api_url
}

output "media_url" {
  description = "Media CDN URL, or null."
  value       = module.edge.media_url
}

output "host_public_ip" {
  description = "Elastic IP of the host."
  value       = module.compute.public_ip
}

output "instance_id" {
  description = "Host instance ID."
  value       = module.compute.instance_id
}

output "shell_command" {
  description = "Open a shell on the host through Session Manager."
  value       = "aws ssm start-session --region ${var.region} --target ${module.compute.instance_id}"
}

output "deploy_command" {
  description = "Upgrade the running stack to another git ref."
  value       = "aws ssm send-command --region ${var.region} --instance-ids ${module.compute.instance_id} --document-name AWS-RunShellScript --parameters 'commands=[\"agentbazaar-deploy <git-ref>\"]'"
}

output "app_secret_name" {
  description = "Put the app's secret env (JSON) here before or right after the first apply."
  value       = module.kms.secret_names["app"]
}

output "buckets" {
  description = "Bucket names by purpose."
  value       = module.storage.bucket_names
}

output "kms_key_arn" {
  description = "Customer-managed KMS key."
  value       = module.kms.key_arn
}

output "alarm_topic_arn" {
  description = "SNS topic for alarms."
  value       = module.observability.alarm_topic_arn
}

output "budget_name" {
  description = "Monthly budget, or null."
  value       = module.budget.budget_name
}

output "ci_role_arn" {
  description = "Role for GitHub Actions, or null."
  value       = one(module.ci_oidc[*].role_arn)
}

output "postgres_major_version" {
  description = "PostgreSQL major version the host's Compose stack is expected to run."
  value       = var.postgres_major_version
}

output "tags" {
  description = "Tags applied to every resource."
  value       = module.naming.tags
}
