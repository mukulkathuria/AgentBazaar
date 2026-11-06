# Security policy assertions on the modules growth adds, planned directly against mocked AWS.
# The edge module is asserted from growth.tftest.hcl instead: `terraform validate` validates every
# module a run targets on its own, and a module with configuration_aliases cannot validate alone.

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
  # OpenTofu fills computed attributes with random strings at plan time (Terraform leaves them unknown), and the
  # AWS provider rejects those where it validates an ARN or ID: give the ones other resources reference real shapes.
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/mock" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:ap-south-1:123456789012:mock" } }
  mock_resource "aws_launch_template" { defaults = { id = "lt-0123456789abcdef0" } }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
  mock_resource "aws_rds_cluster" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
}

variables {
  name = "acme-staging-aps1"
}

run "rds_is_private_encrypted_and_follows_version_18" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    subnet_ids                 = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn                = "arn:aws:kms:ap-south-1:123456789012:key/test"
    postgres_major_version     = "18"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
  }

  assert {
    condition     = aws_db_instance.this[0].publicly_accessible == false
    error_message = "RDS must not be publicly accessible."
  }

  assert {
    condition     = aws_db_instance.this[0].storage_encrypted == true
    error_message = "RDS storage must be encrypted."
  }

  assert {
    condition     = aws_db_parameter_group.this[0].family == "postgres18" && aws_db_instance.this[0].engine_version == "18"
    error_message = "Engine version and parameter group family must follow postgres_major_version."
  }

  assert {
    condition     = aws_db_instance.this[0].backup_retention_period >= 1 && aws_db_instance.this[0].manage_master_user_password
    error_message = "Backups (PITR) must be on and the master password managed by RDS, never in code."
  }

  assert {
    condition     = aws_db_instance.this[0].deletion_protection == false && aws_db_instance.this[0].skip_final_snapshot
    error_message = "Non-prod databases are deletable without a final snapshot."
  }
}

run "rds_follows_version_19_and_protects_prod" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                 = "vpc-0123456789abcdef0"
    subnet_ids             = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn            = "arn:aws:kms:ap-south-1:123456789012:key/test"
    postgres_major_version = "19"
    deletion_protection    = true
    read_replicas          = 1
  }

  assert {
    condition     = aws_db_parameter_group.this[0].family == "postgres19"
    error_message = "The parameter group family must follow postgres_major_version."
  }

  assert {
    condition     = aws_db_instance.this[0].deletion_protection && !aws_db_instance.this[0].skip_final_snapshot
    error_message = "Prod databases must have deletion protection and a final snapshot."
  }

  assert {
    condition     = aws_db_instance.replica[0].publicly_accessible == false && aws_db_instance.replica[0].storage_encrypted
    error_message = "Read replicas must be private and encrypted."
  }
}

run "database_rejects_unsupported_versions" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                 = "vpc-0123456789abcdef0"
    subnet_ids             = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn            = "arn:aws:kms:ap-south-1:123456789012:key/test"
    postgres_major_version = "15"
  }

  expect_failures = [var.postgres_major_version]
}

run "eks_is_encrypted_private_and_least_privilege" {
  command = plan

  module {
    source = "../../modules/eks"
  }

  variables {
    region                = "ap-south-1"
    subnet_ids            = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn           = "arn:aws:kms:ap-south-1:123456789012:key/test"
    admin_cidrs           = []
    alb_security_group_id = "sg-0123456789abcdef0"
    target_group_arns     = ["arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/acme-web/0123456789abcdef"]
  }

  assert {
    condition     = aws_eks_cluster.this.vpc_config[0].endpoint_public_access == false
    error_message = "Without admin_cidrs the API endpoint must be private."
  }

  assert {
    condition     = one(aws_eks_cluster.this.encryption_config[0].resources) == "secrets"
    error_message = "Kubernetes secrets must be envelope-encrypted with KMS."
  }

  assert {
    condition     = aws_launch_template.node.metadata_options[0].http_tokens == "required" && aws_launch_template.node.block_device_mappings[0].ebs[0].encrypted == "true"
    error_message = "Nodes must require IMDSv2 and encrypt their volumes."
  }

  assert {
    condition = alltrue(flatten([
      for d in [
        data.aws_iam_policy_document.cluster_trust,
        data.aws_iam_policy_document.ec2_trust,
        data.aws_iam_policy_document.pod_trust,
        data.aws_iam_policy_document.cluster_kms,
        data.aws_iam_policy_document.ebs_csi_kms,
        data.aws_iam_policy_document.lb_controller,
      ] : [for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"]
    ]))
    error_message = "EKS IAM policies must not use wildcard actions."
  }
}

run "eks_public_endpoint_is_limited_to_admin_cidrs" {
  command = plan

  module {
    source = "../../modules/eks"
  }

  variables {
    region                = "ap-south-1"
    subnet_ids            = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn           = "arn:aws:kms:ap-south-1:123456789012:key/test"
    admin_cidrs           = ["203.0.113.10/32"]
    alb_security_group_id = "sg-0123456789abcdef0"
    target_group_arns     = ["arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/acme-web/0123456789abcdef"]
  }

  assert {
    condition     = aws_eks_cluster.this.vpc_config[0].endpoint_public_access && aws_eks_cluster.this.vpc_config[0].public_access_cidrs == toset(["203.0.113.10/32"])
    error_message = "The public endpoint must only accept admin_cidrs."
  }
}

run "cache_encrypts_at_rest_and_in_transit" {
  command = plan

  module {
    source = "../../modules/cache"
  }

  variables {
    vpc_id      = "vpc-0123456789abcdef0"
    subnet_ids  = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    kms_key_arn = "arn:aws:kms:ap-south-1:123456789012:key/test"
  }

  assert {
    condition     = aws_elasticache_replication_group.this.at_rest_encryption_enabled == "true" && aws_elasticache_replication_group.this.transit_encryption_enabled
    error_message = "Valkey must encrypt at rest and in transit."
  }

  assert {
    condition     = aws_elasticache_replication_group.this.engine == "valkey" && aws_elasticache_replication_group.this.parameter_group_name == "default.valkey8"
    error_message = "The cache must run the Valkey engine with the matching parameter group."
  }
}
