# Security policy assertions on the modules lite uses, planned directly against mocked AWS.
# Wildcard checks cover Allow statements; the only wildcard Deny is the S3 TLS-only guard.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["xx-test-1a", "xx-test-1b", "xx-test-1c"] }
  }
}

run "lite_network_exposes_only_web_and_admin_ssh" {
  command = plan

  module {
    source = "../../modules/network"
  }

  variables {
    name                   = "acme-staging-aps1"
    nat_gateway_mode       = "none"
    admin_cidrs            = ["203.0.113.10/32"]
    allow_ssh              = true
    web_sg_internet_egress = true
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 0 && length(aws_route.private_nat) == 0
    error_message = "nat_gateway_mode = none must not create NAT gateways or NAT routes."
  }

  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.web : r.from_port]) == toset([80, 443]) && alltrue([for r in aws_vpc_security_group_ingress_rule.web : r.cidr_ipv4 == "0.0.0.0/0"])
    error_message = "The web security group must open exactly 80 and 443 to the internet."
  }

  assert {
    condition     = keys(aws_vpc_security_group_ingress_rule.ssh) == ["203.0.113.10/32"] && aws_vpc_security_group_ingress_rule.ssh["203.0.113.10/32"].from_port == 22
    error_message = "Port 22 must be open to admin_cidrs only."
  }

  assert {
    condition     = alltrue([for s in aws_subnet.public : !s.map_public_ip_on_launch])
    error_message = "Public subnets must not hand out public IPs automatically."
  }
}

run "storage_buckets_are_private_versioned_and_kms_encrypted" {
  command = plan

  module {
    source = "../../modules/storage"
  }

  variables {
    name        = "acme-staging-aps1"
    kms_key_arn = "arn:aws:kms:ap-south-1:123456789012:key/test"
  }

  assert {
    condition     = length(aws_s3_bucket_public_access_block.this) == 3
    error_message = "media, backups and logs buckets must all exist."
  }

  assert {
    condition = alltrue([
      for b in aws_s3_bucket_public_access_block.this :
      b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets
    ])
    error_message = "Every bucket must block all public access."
  }

  assert {
    condition     = alltrue([for v in aws_s3_bucket_versioning.this : v.versioning_configuration[0].status == "Enabled"])
    error_message = "Every bucket must be versioned."
  }

  assert {
    condition = alltrue(flatten([
      for e in aws_s3_bucket_server_side_encryption_configuration.this : [
        for r in e.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
      ]
    ]))
    error_message = "Every bucket must use SSE-KMS."
  }

  assert {
    condition = alltrue(flatten([
      for d in data.aws_iam_policy_document.bucket : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "Bucket policies must not allow wildcard actions."
  }

  assert {
    condition = alltrue([
      for d in data.aws_iam_policy_document.bucket :
      anytrue([for s in d.statement : s.effect == "Deny" && anytrue([for c in s.condition : c.variable == "aws:SecureTransport"])])
    ])
    error_message = "Every bucket must deny requests that do not use TLS."
  }
}

run "kms_key_rotates_and_policies_name_actions" {
  command = plan

  module {
    source = "../../modules/secrets-kms"
  }

  variables {
    name             = "acme-staging-aps1"
    region           = "ap-south-1"
    secret_prefix    = "acme/staging"
    secrets          = { app = "test" }
    allow_cloudtrail = true
    allow_cloudfront = true
  }

  assert {
    condition     = aws_kms_key.this.enable_key_rotation
    error_message = "KMS key rotation must be on."
  }

  assert {
    condition     = aws_secretsmanager_secret.this["app"].name == "acme/staging/app"
    error_message = "Secret placeholder must be named <project>/<environment>/<key>."
  }

  assert {
    condition = alltrue(flatten([
      for s in data.aws_iam_policy_document.key.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
    ]))
    error_message = "The key policy must not allow wildcard actions."
  }
}

run "lite_host_is_hardened" {
  command = plan

  module {
    source = "../../modules/compute-lite"
  }

  variables {
    name               = "acme-staging-aps1"
    region             = "ap-south-1"
    availability_zone  = "ap-south-1a"
    subnet_id          = "subnet-0123456789abcdef0"
    security_group_ids = ["sg-0123456789abcdef0"]
    kms_key_arn        = "arn:aws:kms:ap-south-1:123456789012:key/test"
    repo_url           = "https://example.com/agentbazaar.git"
    app_version        = "v0.9.0"
    app_secret_arn     = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:acme/staging/app"
    s3_bucket_arns     = ["arn:aws:s3:::acme-media", "arn:aws:s3:::acme-backups"]
    log_group_name     = "/acme-staging-aps1/app"
    log_group_arn      = "arn:aws:logs:ap-south-1:123456789012:log-group:/acme-staging-aps1/app"
  }

  assert {
    condition     = aws_instance.this.metadata_options[0].http_tokens == "required"
    error_message = "The host must require IMDSv2."
  }

  assert {
    condition     = aws_instance.this.instance_type == "t4g.medium" && strcontains(data.aws_ssm_parameter.ami.name, "/arm64/")
    error_message = "Default host must be Graviton (t4g.medium) with an arm64 AMI."
  }

  assert {
    condition     = aws_instance.this.root_block_device[0].encrypted && aws_ebs_volume.data.encrypted && aws_ebs_volume.data.type == "gp3"
    error_message = "Root and data volumes must be encrypted gp3."
  }

  assert {
    condition = alltrue(flatten([
      for d in [data.aws_iam_policy_document.assume, data.aws_iam_policy_document.host] : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "Host IAM policies must not use wildcard actions."
  }
}

run "x86_instance_types_get_an_amd64_ami" {
  command = plan

  module {
    source = "../../modules/compute-lite"
  }

  variables {
    name               = "acme-staging-aps1"
    region             = "ap-south-1"
    availability_zone  = "ap-south-1a"
    subnet_id          = "subnet-0123456789abcdef0"
    security_group_ids = ["sg-0123456789abcdef0"]
    instance_type      = "t3.medium"
    kms_key_arn        = "arn:aws:kms:ap-south-1:123456789012:key/test"
    repo_url           = "https://example.com/agentbazaar.git"
    app_version        = "v0.9.0"
    app_secret_arn     = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:acme/staging/app"
    s3_bucket_arns     = ["arn:aws:s3:::acme-media"]
    log_group_name     = "/acme-staging-aps1/app"
    log_group_arn      = "arn:aws:logs:ap-south-1:123456789012:log-group:/acme-staging-aps1/app"
  }

  assert {
    condition     = strcontains(data.aws_ssm_parameter.ami.name, "/amd64/")
    error_message = "A non-Graviton instance type must resolve an amd64 AMI."
  }
}

run "ci_role_is_least_privilege" {
  command = plan

  module {
    source = "../../modules/ci-oidc"
  }

  variables {
    name              = "acme-staging-aps1"
    github_repository = "example-org/agentbazaar"
    policy_statements = [{ sid = "Deploy", actions = ["ssm:SendCommand"], resources = ["arn:aws:ec2:ap-south-1:123456789012:instance/i-0123456789abcdef0"] }]
  }

  assert {
    condition = alltrue(flatten([
      for d in [data.aws_iam_policy_document.trust, data.aws_iam_policy_document.permissions] : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "CI role policies must not use wildcard actions."
  }

  assert {
    condition     = contains(flatten([for c in data.aws_iam_policy_document.trust.statement[0].condition : c.values]), "repo:example-org/agentbazaar:ref:refs/heads/main")
    error_message = "The CI role must trust only the configured repository and ref."
  }
}

run "ci_role_rejects_wildcard_actions" {
  command = plan

  module {
    source = "../../modules/ci-oidc"
  }

  variables {
    name              = "acme-staging-aps1"
    github_repository = "example-org/agentbazaar"
    policy_statements = [{ sid = "TooBroad", actions = ["s3:*"], resources = ["*"] }]
  }

  expect_failures = [var.policy_statements]
}

run "budget_exists_by_default" {
  command = plan

  module {
    source = "../../modules/budget"
  }

  variables {
    name               = "acme-staging-aps1"
    monthly_budget_usd = 50
    alert_emails       = ["ops@example.com"]
  }

  assert {
    condition     = length(aws_budgets_budget.this) == 1 && aws_budgets_budget.this[0].time_unit == "MONTHLY"
    error_message = "A monthly budget alarm must exist by default."
  }
}

run "security_controls_use_named_actions" {
  command = plan

  module {
    source = "../../modules/security"
  }

  variables {
    name               = "acme-staging-aps1"
    kms_key_arn        = "arn:aws:kms:ap-south-1:123456789012:key/test"
    logs_bucket_name   = "acme-logs"
    enable_cloudtrail  = true
    enable_guardduty   = true
    enable_securityhub = true
    enable_config      = true
  }

  assert {
    condition     = aws_cloudtrail.this[0].enable_log_file_validation && aws_cloudtrail.this[0].is_multi_region_trail
    error_message = "CloudTrail must validate log files and cover every region."
  }

  assert {
    condition = alltrue(flatten([
      for d in [data.aws_iam_policy_document.config_trust, data.aws_iam_policy_document.config_delivery] : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "AWS Config role policies must not use wildcard actions."
  }
}
