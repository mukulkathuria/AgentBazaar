# terraform -chdir=deploy/terraform/profiles/scale apply -var-file=../../examples/scale.tfvars
# Placeholder values: replace every one of them with your own.

project_name       = "agentbazaar"
environment        = "prod"
region             = "ap-south-1"
backup_copy_region = "ap-southeast-1" # AWS Backup copies land here (must differ from region)
domain_name        = "shop.example.com"
profile            = "scale"
admin_cidrs        = ["203.0.113.10/32"]
monthly_budget_usd = 4000
budget_alert_email = "ops@example.com"

# Sizing and options (defaults shown)
# node_instance_types    = ["m7g.xlarge"]
# node_min               = 3
# node_max               = 10
# enable_karpenter       = false
# database_deployment    = "rds"           # rds | aurora | self-managed
# db_instance_class      = "db.r7g.large"
# db_multi_az            = true
# db_read_replicas       = 1
# cache_cluster_mode     = true            # needs a cluster-aware Valkey client in the API
# msk_client_broker      = "TLS"
# opensearch_instance_count = 3
# enable_shield_advanced = false           # needs a paid Shield Advanced subscription first
# enable_securityhub     = true            # disable if your organisation manages it centrally
# enable_config          = true
# github_repository      = "<owner>/<repo>"
