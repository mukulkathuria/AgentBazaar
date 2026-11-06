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
}

mock_provider "aws" {
  alias = "us_east_1"
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
