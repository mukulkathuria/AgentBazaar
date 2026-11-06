# Growth: EKS (managed Graviton nodes), RDS PostgreSQL, ElastiCache Valkey, ALB + WAF,
# S3 + CloudFront. Meilisearch, NATS and OpenBao run on the cluster through their Helm charts.

locals {
  is_prod  = module.naming.is_production
  protect  = var.deletion_protection == null ? module.naming.is_production : var.deletion_protection
  pg_major = coalesce(var.postgres_major_version, var.database_deployment == "self-managed" ? "19" : "18")
}

module "naming" {
  source       = "../../modules/naming"
  project_name = var.project_name
  environment  = var.environment
  region       = var.region
  profile      = var.profile
}

module "network" {
  source           = "../../modules/network"
  name             = module.naming.prefix
  cidr             = var.vpc_cidr
  az_count         = var.az_count
  nat_gateway_mode = "single"
}

module "kms" {
  source               = "../../modules/secrets-kms"
  name                 = module.naming.prefix
  region               = var.region
  secret_prefix        = module.naming.secret_prefix
  secret_recovery_days = local.is_prod ? 30 : 7
  allow_cloudtrail     = var.enable_cloudtrail
  allow_cloudfront     = var.enable_cdn
  secrets = {
    app = "AgentBazaar secret env as one JSON object: DATABASE_URL, QUOTE_SIGNING_KEY, PII_MASTER_KEY, PII_BLIND_INDEX_KEY, JWT_PRIVATE_KEY, OPENBAO_TOKEN, MEILISEARCH_API_KEY and the payment adapter keys."
  }
}

module "storage" {
  source                      = "../../modules/storage"
  name                        = module.naming.prefix
  kms_key_arn                 = module.kms.key_arn
  force_destroy               = var.force_destroy_buckets
  cdn_bucket                  = var.enable_cdn ? "media" : null
  cloudfront_distribution_arn = module.edge.cdn_distribution_arn
  cloudtrail_bucket           = var.enable_cloudtrail ? "logs" : null
}

module "edge" {
  source = "../../modules/edge"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  name                              = module.naming.prefix
  domain_name                       = var.domain_name
  zone_name                         = var.route53_zone_name
  enable_alb                        = true
  vpc_id                            = module.network.vpc_id
  public_subnet_ids                 = module.network.public_subnet_ids
  alb_security_group_id             = module.network.web_security_group_id
  deletion_protection               = local.protect
  enable_waf                        = var.enable_waf
  enable_cdn                        = var.enable_cdn
  media_bucket_regional_domain_name = module.storage.bucket_regional_domain_names["media"]
}

module "eks" {
  source                = "../../modules/eks"
  name                  = module.naming.prefix
  region                = var.region
  kubernetes_version    = var.kubernetes_version
  subnet_ids            = module.network.private_subnet_ids
  admin_cidrs           = var.admin_cidrs
  kms_key_arn           = module.kms.key_arn
  deletion_protection   = local.protect
  log_retention_days    = var.log_retention_days
  node_instance_types   = var.node_instance_types
  node_min              = var.node_min
  node_desired          = var.node_desired
  node_max              = var.node_max
  admin_role_arns       = var.eks_admin_role_arns
  app_namespace         = var.app_namespace
  namespace_deployers   = var.github_repository == null ? {} : { ci = module.ci_oidc[0].role_arn }
  alb_security_group_id = module.network.web_security_group_id
  target_group_arns     = values(module.edge.target_group_arns)
}

module "database" {
  source                     = "../../modules/database"
  name                       = module.naming.prefix
  deployment                 = var.database_deployment
  postgres_major_version     = local.pg_major
  instance_class             = var.db_instance_class
  allocated_storage_gb       = var.db_allocated_storage_gb
  multi_az                   = var.db_multi_az
  read_replicas              = var.db_read_replicas
  backup_retention_days      = var.db_backup_retention_days
  deletion_protection        = local.protect
  kms_key_arn                = module.kms.key_arn
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  log_retention_days         = var.log_retention_days
}

module "cache" {
  source                     = "../../modules/cache"
  name                       = module.naming.prefix
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  kms_key_arn                = module.kms.key_arn
  engine_version             = var.cache_engine_version
  node_type                  = var.cache_node_type
  replicas                   = var.cache_replicas
}

module "observability" {
  source                    = "../../modules/observability"
  name                      = module.naming.prefix
  kms_key_arn               = module.kms.key_arn
  log_retention_days        = var.log_retention_days
  alarm_email               = coalesce(var.alarm_email, var.budget_alert_email)
  enable_managed_prometheus = var.enable_managed_prometheus
  enable_managed_grafana    = var.enable_managed_grafana
  alarms = merge(
    {
      alb-5xx = {
        namespace          = "AWS/ApplicationELB"
        metric_name        = "HTTPCode_ELB_5XX_Count"
        dimensions         = { LoadBalancer = module.edge.alb_arn_suffix }
        statistic          = "Sum"
        threshold          = 10
        evaluation_periods = 1
        description        = "The load balancer returned more than 10 5xx responses in 5 minutes."
      }
      app-5xx = {
        namespace          = "AWS/ApplicationELB"
        metric_name        = "HTTPCode_Target_5XX_Count"
        dimensions         = { LoadBalancer = module.edge.alb_arn_suffix }
        statistic          = "Sum"
        threshold          = 25
        evaluation_periods = 1
        description        = "The app returned more than 25 5xx responses in 5 minutes."
      }
    },
    {
      for k, v in {
        db-cpu = {
          namespace   = "AWS/RDS"
          metric_name = "CPUUtilization"
          dimensions  = var.database_deployment == "aurora" ? { DBClusterIdentifier = module.database.identifier } : { DBInstanceIdentifier = module.database.identifier }
          threshold   = 80
          description = "Database CPU above 80% for 15 minutes."
        }
      } : k => v if var.database_deployment != "self-managed"
    },
  )
}

module "security" {
  source            = "../../modules/security"
  name              = module.naming.prefix
  kms_key_arn       = module.kms.key_arn
  logs_bucket_name  = module.storage.bucket_names["logs"]
  enable_cloudtrail = var.enable_cloudtrail
  enable_guardduty  = var.enable_guardduty
}

module "budget" {
  source             = "../../modules/budget"
  name               = module.naming.prefix
  enabled            = var.enable_budget
  monthly_budget_usd = var.monthly_budget_usd
  alert_emails       = [var.budget_alert_email]
}

# CI gets kubeconfig (DescribeCluster) and edit rights in the app namespace only (EKS access entry).
module "ci_oidc" {
  source               = "../../modules/ci-oidc"
  count                = var.github_repository == null ? 0 : 1
  name                 = module.naming.prefix
  github_repository    = var.github_repository
  subjects             = var.github_oidc_subjects
  create_oidc_provider = var.create_github_oidc_provider
  policy_statements = [
    { sid = "DescribeCluster", actions = ["eks:DescribeCluster"], resources = [module.eks.cluster_arn] },
  ]
}
