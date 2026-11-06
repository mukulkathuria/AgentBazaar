# terraform -chdir=deploy/terraform/profiles/lite apply -var-file=../../examples/lite.tfvars
# Placeholder values: replace every one of them with your own.

project_name       = "agentbazaar"
environment        = "staging"
region             = "ap-south-1"
domain_name        = "shop.example.com"
profile            = "lite"
admin_cidrs        = ["203.0.113.10/32"] # your office/VPN egress IP; [] closes port 22 entirely
monthly_budget_usd = 50
budget_alert_email = "ops@example.com"

# Sizing and options (defaults shown)
# instance_type          = "t4g.medium"
# data_volume_gb         = 50
# app_version            = "main"          # pin a release tag in production
# repo_url               = "https://github.com/<you>/AgentBazaar.git"
# postgres_major_version = "19"            # Postgres runs inside Compose on the host
# enable_cdn             = false
# enable_cloudtrail      = false
# github_repository      = "<owner>/<repo>" # creates a GitHub OIDC deploy role
