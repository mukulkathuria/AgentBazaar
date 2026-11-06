output "bucket_names" {
  description = "Bucket names by key. Ready only once bucket policies exist (CloudTrail checks them on create)."
  value       = { for k, b in aws_s3_bucket.this : k => b.bucket }
  depends_on  = [aws_s3_bucket_policy.this]
}

output "bucket_arns" {
  description = "Bucket ARNs by key."
  value       = { for k, b in aws_s3_bucket.this : k => b.arn }
}

output "bucket_regional_domain_names" {
  description = "Regional domain names by key (CloudFront origins)."
  value       = { for k, b in aws_s3_bucket.this : k => b.bucket_regional_domain_name }
}
