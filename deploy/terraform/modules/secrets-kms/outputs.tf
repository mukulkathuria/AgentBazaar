output "key_arn" {
  description = "ARN of the customer-managed KMS key."
  value       = aws_kms_key.this.arn
}

output "key_alias" {
  description = "Alias of the KMS key."
  value       = aws_kms_alias.this.name
}

output "secret_arns" {
  description = "Secret placeholder ARNs by name."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "secret_names" {
  description = "Secret placeholder names by key (set values with aws secretsmanager put-secret-value)."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.name }
}
