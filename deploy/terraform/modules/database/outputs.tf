output "deployment" {
  description = "rds, aurora or self-managed."
  value       = var.deployment
}

output "postgres_major_version" {
  description = "PostgreSQL major version this stack expects."
  value       = var.postgres_major_version
}

output "parameter_group_family" {
  description = "Parameter group family in use, or null for self-managed."
  value       = local.managed ? local.family : null
}

output "identifier" {
  description = "DB instance identifier (rds) or cluster identifier (aurora), or null."
  value       = local.managed ? local.id : null
}

output "arn" {
  description = "DB instance or cluster ARN (AWS Backup selections), or null."
  value       = one(concat(aws_db_instance.this[*].arn, aws_rds_cluster.this[*].arn))
}

output "endpoint" {
  description = "Writer endpoint hostname, or null."
  value       = one(concat(aws_db_instance.this[*].address, aws_rds_cluster.this[*].endpoint))
}

output "reader_endpoints" {
  description = "Read endpoints: replica hostnames (rds) or the cluster reader endpoint (aurora)."
  value       = concat(aws_db_instance.replica[*].address, aws_rds_cluster.this[*].reader_endpoint)
}

output "port" {
  description = "PostgreSQL port."
  value       = 5432
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret RDS manages (and rotates) for the master user, or null."
  value       = one(concat(aws_db_instance.this[*].master_user_secret[0].secret_arn, aws_rds_cluster.this[*].master_user_secret[0].secret_arn))
}

output "security_group_id" {
  description = "Database security group, or null."
  value       = one(aws_security_group.this[*].id)
}
