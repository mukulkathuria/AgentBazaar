# Plans the scale root module against mocked AWS providers: no credentials, no API calls.
# Run: terraform -chdir=deploy/terraform/profiles/scale init -backend=false && terraform -chdir=deploy/terraform/profiles/scale test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["xx-test-1a", "xx-test-1b", "xx-test-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  # OpenTofu fills computed attributes with random strings at plan time (Terraform leaves them unknown), and the
  # AWS provider rejects those where it validates an ARN or ID: give the ones other resources reference real shapes.
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-0000-0000-000000000000" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/mock" } }
  mock_resource "aws_sns_topic" { defaults = { arn = "arn:aws:sns:ap-south-1:123456789012:mock" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:ap-south-1:123456789012:mock" } }
  mock_resource "aws_lb" { defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/mock/0123456789abcdef" } }
  mock_resource "aws_lb_listener" { defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:listener/app/mock/0123456789abcdef/0123456789abcdef" } }
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/mock/0123456789abcdef" } }
  mock_resource "aws_wafv2_web_acl" { defaults = { arn = "arn:aws:wafv2:ap-south-1:123456789012:regional/webacl/mock/00000000-0000-0000-0000-000000000000" } }
  mock_resource "aws_launch_template" { defaults = { id = "lt-0123456789abcdef0" } }
  mock_resource "aws_msk_configuration" { defaults = { arn = "arn:aws:kafka:ap-south-1:123456789012:configuration/mock/00000000-0000-0000-0000-000000000000-1" } }
  mock_resource "aws_backup_vault" { defaults = { arn = "arn:aws:backup:ap-south-1:123456789012:backup-vault:mock" } }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
  mock_resource "aws_rds_cluster" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:ap-south-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [
        { domain_name = "shop.example.com", resource_record_name = "_a.shop.example.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
        { domain_name = "api.shop.example.com", resource_record_name = "_b.api.shop.example.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
      ]
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [
        { domain_name = "media.shop.example.com", resource_record_name = "_c.media.shop.example.com.", resource_record_type = "CNAME", resource_record_value = "_c.acm-validations.aws." },
      ]
    }
  }
}

mock_provider "aws" {
  alias = "backup_copy"
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000" } }
  mock_resource "aws_backup_vault" { defaults = { arn = "arn:aws:backup:ap-southeast-1:123456789012:backup-vault:mock" } }
}

variables {
  project_name       = "agentbazaar"
  environment        = "prod"
  region             = "ap-south-1"
  backup_copy_region = "ap-southeast-1"
  domain_name        = "shop.example.com"
  admin_cidrs        = ["203.0.113.10/32"]
  monthly_budget_usd = 4000
  budget_alert_email = "ops@example.com"
}

run "plans_with_defaults" {
  command = plan

  assert {
    condition     = length(module.network.nat_gateway_ids) == 3
    error_message = "Scale runs one NAT gateway per AZ across three AZs."
  }

  assert {
    condition     = output.database.deployment == "rds" && output.database.parameter_group_family == "postgres18"
    error_message = "Scale defaults to RDS PostgreSQL 18."
  }

  assert {
    condition     = output.security_controls == { cloudtrail = true, guardduty = true, securityhub = true, config = true }
    error_message = "Scale turns on CloudTrail, GuardDuty, Security Hub and AWS Config."
  }

  assert {
    condition     = module.budget.budget_name == "agentbazaar-prod-aps1-monthly"
    error_message = "The budget alarm must exist by default."
  }

  assert {
    condition = output.tags == {
      Project     = "agentbazaar"
      Environment = "prod"
      Profile     = "scale"
      ManagedBy   = "terraform"
    }
    error_message = "Every resource must carry Project, Environment, Profile and ManagedBy tags."
  }

  assert {
    condition     = one([for r in aws_backup_plan.this.rule : r.schedule == "cron(0 3 * * ? *)" && length(r.copy_action) == 1])
    error_message = "Daily backups must be copied to the second region."
  }

  assert {
    condition     = length(aws_backup_selection.database) == 1
    error_message = "The managed database must be in the backup plan."
  }
}

run "names_follow_project_name" {
  command = plan

  variables {
    project_name = "acme-shop"
  }

  assert {
    condition     = output.cluster_name == "acme-shop-prod-aps1"
    error_message = "The cluster name must follow project_name."
  }

  assert {
    condition     = alltrue([for name in values(output.buckets) : startswith(name, "acme-shop-prod-aps1-")])
    error_message = "Bucket names must follow project_name."
  }

  assert {
    condition     = aws_backup_vault.primary.name == "acme-shop-prod-aps1" && aws_backup_vault.copy.name == "acme-shop-prod-aps1-copy"
    error_message = "Backup vault names must follow project_name."
  }
}

run "postgres_18" {
  command = plan

  variables {
    postgres_major_version = "18"
  }

  assert {
    condition     = output.database.parameter_group_family == "postgres18"
    error_message = "The RDS parameter group family must follow postgres_major_version."
  }
}

run "postgres_19" {
  command = plan

  variables {
    postgres_major_version = "19"
  }

  assert {
    condition     = output.database.parameter_group_family == "postgres19"
    error_message = "The RDS parameter group family must follow postgres_major_version."
  }
}

run "aurora_postgres_18" {
  command = plan

  variables {
    database_deployment    = "aurora"
    postgres_major_version = "18"
  }

  assert {
    condition     = output.database.parameter_group_family == "aurora-postgresql18"
    error_message = "The Aurora cluster parameter group family must follow postgres_major_version."
  }
}

run "aurora_postgres_19" {
  command = plan

  variables {
    database_deployment    = "aurora"
    postgres_major_version = "19"
  }

  assert {
    condition     = output.database.parameter_group_family == "aurora-postgresql19"
    error_message = "The Aurora cluster parameter group family must follow postgres_major_version."
  }
}

run "karpenter_flag" {
  command = plan

  variables {
    enable_karpenter = true
  }

  assert {
    condition     = output.karpenter.interruption_queue == "agentbazaar-prod-aps1-karpenter"
    error_message = "enable_karpenter must create the interruption queue."
  }
}

run "backup_copy_must_leave_the_region" {
  command = plan

  variables {
    backup_copy_region = "ap-south-1"
  }

  expect_failures = [aws_backup_vault.copy]
}

run "rejects_another_profile" {
  command = plan

  variables {
    profile = "lite"
  }

  expect_failures = [var.profile]
}
