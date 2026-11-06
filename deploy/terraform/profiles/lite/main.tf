# Lite: one Graviton host running the Docker Compose stack (Postgres included), S3 for media and
# backups, Route 53, optional CloudFront, Secrets Manager, CloudWatch and a budget alarm. No NAT.

data "aws_partition" "current" {}

locals {
  is_prod = module.naming.is_production
  protect = var.deletion_protection == null ? module.naming.is_production : var.deletion_protection
}

module "naming" {
  source       = "../../modules/naming"
  project_name = var.project_name
  environment  = var.environment
  region       = var.region
  profile      = var.profile
}

module "network" {
  source                 = "../../modules/network"
  name                   = module.naming.prefix
  cidr                   = var.vpc_cidr
  az_count               = 2
  nat_gateway_mode       = "none"
  admin_cidrs            = var.admin_cidrs
  allow_ssh              = true
  web_sg_internet_egress = true
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
    app = "AgentBazaar secret env as one JSON object: POSTGRES_PASSWORD, QUOTE_SIGNING_KEY, PII_MASTER_KEY, PII_BLIND_INDEX_KEY, JWT_PRIVATE_KEY and the payment adapter keys (RAZORPAY_* or YOUPI_*)."
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

module "observability" {
  source             = "../../modules/observability"
  name               = module.naming.prefix
  kms_key_arn        = module.kms.key_arn
  log_retention_days = var.log_retention_days
  alarm_email        = coalesce(var.alarm_email, var.budget_alert_email)
  alarms = {
    host-status-check = {
      namespace           = "AWS/EC2"
      metric_name         = "StatusCheckFailed"
      dimensions          = { InstanceId = module.compute.instance_id }
      statistic           = "Maximum"
      threshold           = 1
      comparison_operator = "GreaterThanOrEqualToThreshold"
      period              = 60
      evaluation_periods  = 2
      treat_missing_data  = "breaching"
      description         = "The lite host failed an EC2 status check."
    }
    host-cpu = {
      namespace   = "AWS/EC2"
      metric_name = "CPUUtilization"
      dimensions  = { InstanceId = module.compute.instance_id }
      threshold   = 85
      description = "The lite host has been above 85% CPU for 15 minutes."
    }
  }
}

module "compute" {
  source                 = "../../modules/compute-lite"
  name                   = module.naming.prefix
  region                 = var.region
  availability_zone      = module.network.azs[0]
  subnet_id              = module.network.public_subnet_ids[0]
  security_group_ids     = compact([module.network.web_security_group_id, module.network.ssh_security_group_id])
  instance_type          = var.instance_type
  root_volume_gb         = var.root_volume_gb
  data_volume_gb         = var.data_volume_gb
  kms_key_arn            = module.kms.key_arn
  ssh_key_name           = var.ssh_key_name
  termination_protection = local.protect
  repo_url               = var.repo_url
  app_version            = var.app_version
  compose_file           = var.compose_file
  app_secret_arn         = module.kms.secret_arns["app"]
  s3_bucket_arns         = [module.storage.bucket_arns["media"], module.storage.bucket_arns["backups"]]
  log_group_name         = module.observability.log_group_names["app"]
  log_group_arn          = module.observability.log_group_arns["app"]
  # Non-secret .env for deploy/compose/docker-compose.yml (Caddy reads SITE_DOMAIN and API_DOMAIN).
  app_env = merge({
    PROFILE                = "lite"
    NODE_ENV               = "production"
    PUBLIC_WEB_URL         = module.edge.web_url
    PUBLIC_API_URL         = module.edge.api_url
    CORS_ORIGINS           = module.edge.web_url
    SITE_DOMAIN            = var.domain_name
    API_DOMAIN             = "api.${var.domain_name}"
    POSTGRES_MAJOR_VERSION = var.postgres_major_version
  }, var.extra_app_env)
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
  host_ip                           = module.compute.public_ip
  enable_cdn                        = var.enable_cdn
  media_bucket_regional_domain_name = module.storage.bucket_regional_domain_names["media"]
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

# CI redeploys by running agentbazaar-deploy on the host through SSM; no SSH keys in CI.
module "ci_oidc" {
  source               = "../../modules/ci-oidc"
  count                = var.github_repository == null ? 0 : 1
  name                 = module.naming.prefix
  github_repository    = var.github_repository
  subjects             = var.github_oidc_subjects
  create_oidc_provider = var.create_github_oidc_provider
  policy_statements = [
    {
      sid       = "RunDeployOnHost"
      actions   = ["ssm:SendCommand"]
      resources = [module.compute.instance_arn, "arn:${data.aws_partition.current.partition}:ssm:${var.region}::document/AWS-RunShellScript"]
    },
    {
      sid       = "ReadDeployResult"
      actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
      resources = ["*"]
    },
  ]
}
