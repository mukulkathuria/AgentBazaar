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

output "cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "kubeconfig_command" {
  description = "Writes a kubeconfig entry for the cluster."
  value       = module.eks.kubeconfig_command
}

output "lb_controller_role_arn" {
  description = "Pod Identity role the AWS Load Balancer Controller uses (install the chart into kube-system)."
  value       = module.eks.lb_controller_role_arn
}

output "alb_dns_name" {
  description = "ALB DNS name (Route 53 aliases point here)."
  value       = module.edge.alb_dns_name
}

output "waf_web_acl_arn" {
  description = "WAF web ACL on the ALB, or null."
  value       = module.edge.waf_web_acl_arn
}

output "database" {
  description = "Database connection facts. Build DATABASE_URL from an app role, not the rotating master secret."
  value = {
    deployment             = module.database.deployment
    postgres_major_version = module.database.postgres_major_version
    parameter_group_family = module.database.parameter_group_family
    endpoint               = module.database.endpoint
    reader_endpoints       = module.database.reader_endpoints
    port                   = module.database.port
    master_user_secret_arn = module.database.master_user_secret_arn
  }
}

output "cache_url" {
  description = "VALKEY_URL."
  value       = module.cache.url
}

output "kafka_brokers" {
  description = "KAFKA_BROKERS (TLS unless msk_client_broker is PLAINTEXT)."
  value       = module.streaming.bootstrap_brokers
}

output "opensearch_url" {
  description = "OPENSEARCH_URL (fine-grained access control: requests must be SigV4-signed)."
  value       = module.search.url
}

output "opensearch_admin_role_arn" {
  description = "Role mapped to the OpenSearch admin, or null when opensearch_master_user_arn was supplied."
  value       = module.search.admin_role_arn
}

output "karpenter" {
  description = "Values for the Karpenter Helm chart, or null when enable_karpenter is false."
  value       = module.eks.karpenter
}

output "backup" {
  description = "AWS Backup plan and vaults (primary and cross-region copy)."
  value = {
    plan_id    = aws_backup_plan.this.id
    vault      = aws_backup_vault.primary.name
    copy_vault = aws_backup_vault.copy.arn
  }
}

output "security_controls" {
  description = "Account-level security services this stack manages."
  value       = module.security.enabled_controls
}

output "app_secret_name" {
  description = "Secrets Manager placeholder for the app's secret env (JSON)."
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

output "prometheus_endpoint" {
  description = "Managed Prometheus endpoint, or null."
  value       = module.observability.prometheus_endpoint
}

output "budget_name" {
  description = "Monthly budget, or null."
  value       = module.budget.budget_name
}

output "ci_role_arn" {
  description = "Role for GitHub Actions, or null."
  value       = one(module.ci_oidc[*].role_arn)
}

output "tags" {
  description = "Tags applied to every resource."
  value       = module.naming.tags
}

output "helm_values" {
  description = "Values to layer over deploy/helm/agentbazaar/values-scale.yaml (terraform output -raw helm_values > tf-values.yaml)."
  value = yamlencode({
    config = {
      PUBLIC_WEB_URL = module.edge.web_url
      PUBLIC_API_URL = module.edge.api_url
      VALKEY_URL     = module.cache.url
      KAFKA_BROKERS  = module.streaming.bootstrap_brokers
      OPENSEARCH_URL = module.search.url
    }
    targetGroupBindings = {
      enabled = true
      web     = { targetGroupARN = module.edge.target_group_arns["web"] }
      api     = { targetGroupARN = module.edge.target_group_arns["api"] }
    }
    networkPolicy = {
      ingressFrom = [{ ipBlock = { cidr = module.network.vpc_cidr } }]
    }
  })
}
