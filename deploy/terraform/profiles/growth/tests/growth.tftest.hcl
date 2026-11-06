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
}

mock_provider "aws" {
  alias = "us_east_1"
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
