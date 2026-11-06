# terraform -chdir=deploy/terraform/profiles/growth apply -var-file=../../examples/growth.tfvars
# Placeholder values: replace every one of them with your own.

project_name       = "agentbazaar"
environment        = "staging"
region             = "ap-south-1"
domain_name        = "shop.example.com"
profile            = "growth"
admin_cidrs        = ["203.0.113.10/32"] # who may reach the EKS API; [] keeps it private
monthly_budget_usd = 400
budget_alert_email = "ops@example.com"

# Sizing and options (defaults shown)
# node_instance_types    = ["t4g.large"]
# node_min               = 2
# node_max               = 4
# database_deployment    = "rds"           # rds | aurora | self-managed
# postgres_major_version = null            # 18 for RDS/Aurora, 19 for self-managed
# db_instance_class      = "db.t4g.medium"
# db_multi_az            = false
# cache_node_type        = "cache.t4g.small"
# enable_cdn             = true
# enable_waf             = true
# enable_managed_prometheus = false
# eks_admin_role_arns    = ["arn:aws:iam::<account-id>:role/<admin-role>"]
# github_repository      = "<owner>/<repo>"
