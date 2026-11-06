output "web_acl_arn" {
  description = "Web ACL ARN."
  value       = aws_wafv2_web_acl.this.arn
}

output "managed_rule_groups" {
  description = "AWS managed rule groups in the web ACL."
  value       = concat(local.rule_groups, local.bot_control ? ["AWSManagedRulesBotControlRuleSet"] : [])
}
