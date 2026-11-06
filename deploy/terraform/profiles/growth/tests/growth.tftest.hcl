# Plans the growth root module against mocked AWS providers: no credentials, no API calls.
# Run: terraform -chdir=deploy/terraform/profiles/growth init -backend=false && terraform -chdir=deploy/terraform/profiles/growth test

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

variables {
  project_name       = "agentbazaar"
  environment        = "staging"
  region             = "ap-south-1"
  domain_name        = "shop.example.com"
  admin_cidrs        = ["203.0.113.10/32"]
  monthly_budget_usd = 400
  budget_alert_email = "ops@example.com"
}

run "plans_with_defaults" {
  command = plan

  assert {
    condition     = length(module.network.nat_gateway_ids) == 1
    error_message = "Growth uses a single shared NAT gateway."
  }

  assert {
    condition     = output.database.deployment == "rds" && output.database.parameter_group_family == "postgres18"
    error_message = "Growth defaults to RDS PostgreSQL 18."
  }

  assert {
    condition     = module.budget.budget_name == "agentbazaar-staging-aps1-monthly"
    error_message = "The budget alarm must exist by default."
  }

  assert {
    condition = output.tags == {
      Project     = "agentbazaar"
      Environment = "staging"
      Profile     = "growth"
      ManagedBy   = "terraform"
    }
    error_message = "Every resource must carry Project, Environment, Profile and ManagedBy tags."
  }

  assert {
    condition     = output.cluster_name == "agentbazaar-staging-aps1"
    error_message = "The cluster is named after the naming prefix."
  }

  assert {
    condition = alltrue([
      for group in ["AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet"] :
      contains(module.edge.waf_managed_rule_groups, group)
    ])
    error_message = "The ALB's WAF must include the AWS Core rule set and Known bad inputs."
  }
}

run "waf_can_be_turned_off" {
  command = plan

  variables {
    enable_waf = false
  }

  assert {
    condition     = length(module.edge.waf_managed_rule_groups) == 0
    error_message = "enable_waf = false must detach the web ACL."
  }
}

run "names_follow_project_name" {
  command = plan

  variables {
    project_name = "acme-shop"
  }

  assert {
    condition     = output.cluster_name == "acme-shop-staging-aps1"
    error_message = "The cluster name must follow project_name."
  }

  assert {
    condition     = alltrue([for name in values(output.buckets) : startswith(name, "acme-shop-staging-aps1-")])
    error_message = "Bucket names must follow project_name."
  }

  assert {
    condition     = output.app_secret_name == "acme-shop/staging/app" && module.budget.budget_name == "acme-shop-staging-aps1-monthly"
    error_message = "Secret and budget names must follow project_name."
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

run "self_managed_postgres_defaults_to_19" {
  command = plan

  variables {
    database_deployment = "self-managed"
  }

  assert {
    condition     = output.database.postgres_major_version == "19" && output.database.parameter_group_family == null
    error_message = "Self-managed Postgres defaults to 19 and creates no parameter group."
  }
}

run "budget_can_be_turned_off" {
  command = plan

  variables {
    enable_budget = false
  }

  assert {
    condition     = module.budget.budget_name == null
    error_message = "enable_budget = false must remove the budget."
  }
}

run "rejects_another_profile" {
  command = plan

  variables {
    profile = "scale"
  }

  expect_failures = [var.profile]
}
