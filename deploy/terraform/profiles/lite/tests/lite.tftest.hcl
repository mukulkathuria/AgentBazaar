# Plans the lite root module against mocked AWS providers: no credentials, no API calls.
# Run: terraform -chdir=deploy/terraform/profiles/lite init -backend=false && terraform -chdir=deploy/terraform/profiles/lite test

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
  monthly_budget_usd = 50
  budget_alert_email = "ops@example.com"
}

run "plans_with_defaults" {
  command = plan

  assert {
    condition     = length(module.network.nat_gateway_ids) == 0
    error_message = "Lite must not create a NAT gateway."
  }

  assert {
    condition     = module.budget.budget_name == "agentbazaar-staging-aps1-monthly"
    error_message = "The budget alarm must exist by default."
  }

  assert {
    condition = output.tags == {
      Project     = "agentbazaar"
      Environment = "staging"
      Profile     = "lite"
      ManagedBy   = "terraform"
    }
    error_message = "Every resource must carry Project, Environment, Profile and ManagedBy tags."
  }

  assert {
    condition     = output.postgres_major_version == "19"
    error_message = "Lite runs a self-managed Postgres; the documented default is 19."
  }
}

run "names_follow_project_name" {
  command = plan

  variables {
    project_name = "acme-shop"
    environment  = "prod"
  }

  assert {
    condition     = alltrue([for name in values(output.buckets) : startswith(name, "acme-shop-prod-aps1-123456789012-")])
    error_message = "Bucket names must be built from project_name, environment and region."
  }

  assert {
    condition     = output.app_secret_name == "acme-shop/prod/app"
    error_message = "Secret names must be built from project_name and environment."
  }

  assert {
    condition     = module.budget.budget_name == "acme-shop-prod-aps1-monthly"
    error_message = "The budget name must follow project_name."
  }

  assert {
    condition     = output.tags.Project == "acme-shop" && output.tags.Environment == "prod"
    error_message = "Tags must follow project_name and environment."
  }
}

run "no_ssh_without_admin_cidrs" {
  command = plan

  variables {
    admin_cidrs = []
  }

  assert {
    condition     = module.network.ssh_security_group_id == null
    error_message = "Port 22 must stay closed when admin_cidrs is empty."
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

run "postgres_18" {
  command = plan

  variables {
    postgres_major_version = "18"
  }

  assert {
    condition     = output.postgres_major_version == "18"
    error_message = "postgres_major_version must pass through."
  }
}

run "postgres_19" {
  command = plan

  variables {
    postgres_major_version = "19"
  }

  assert {
    condition     = output.postgres_major_version == "19"
    error_message = "postgres_major_version must pass through."
  }
}

run "optional_cdn_and_ci" {
  command = plan

  variables {
    enable_cdn        = true
    enable_cloudtrail = true
    github_repository = "example-org/agentbazaar"
  }

  assert {
    condition     = output.media_url == "https://media.shop.example.com"
    error_message = "enable_cdn must serve media from media.<domain>."
  }
}

run "rejects_another_profile" {
  command = plan

  variables {
    profile = "growth"
  }

  expect_failures = [var.profile]
}
