output "web_url" {
  description = "Storefront URL (PUBLIC_WEB_URL)."
  value       = "https://${var.domain_name}"
}

output "api_url" {
  description = "API URL (PUBLIC_API_URL)."
  value       = "https://${local.api_host}"
}

output "media_url" {
  description = "Media CDN URL, or null without CloudFront."
  value       = var.enable_cdn ? "https://${local.media_host}" : null
}

output "alb_dns_name" {
  description = "ALB DNS name, or null."
  value       = one(aws_lb.this[*].dns_name)
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (CloudWatch LoadBalancer dimension), or null."
  value       = one(aws_lb.this[*].arn_suffix)
}

output "target_group_arns" {
  description = "Target group ARNs by component (web, api) for TargetGroupBinding."
  value       = { for k, tg in aws_lb_target_group.this : k => tg.arn }
}

output "waf_web_acl_arn" {
  description = "WAF web ACL ARN, or null."
  value       = one(module.waf[*].web_acl_arn)
}

output "waf_managed_rule_groups" {
  description = "AWS managed rule groups in the ALB's web ACL (empty without WAF); tune them with waf_count_only_rules."
  value       = local.waf ? module.waf[0].managed_rule_groups : []
}

output "cdn_distribution_arn" {
  description = "Media distribution ARN, or null."
  value       = one(aws_cloudfront_distribution.media[*].arn)
}
