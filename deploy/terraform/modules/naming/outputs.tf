output "prefix" {
  description = "<project>-<environment>-<short region>; every resource name starts with it."
  value       = local.prefix
}

output "short_region" {
  description = "Compact region code used in names (ap-south-1 -> aps1)."
  value       = local.short_region
}

output "secret_prefix" {
  description = "Path prefix for Secrets Manager names: <project>/<environment>."
  value       = "${var.project_name}/${var.environment}"
}

output "is_production" {
  description = "True when environment is \"prod\" (deletion protection, final snapshots, longer retention)."
  value       = var.environment == "prod"
}

output "tags" {
  description = "Tags applied to every resource through the provider's default_tags."
  value = {
    Project     = var.project_name
    Environment = var.environment
    Profile     = var.profile
    ManagedBy   = "terraform"
  }
}
