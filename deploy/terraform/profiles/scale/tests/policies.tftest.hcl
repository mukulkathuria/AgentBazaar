# Security policy assertions on the modules scale adds, planned directly against mocked AWS.

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
  mock_resource "aws_msk_configuration" { defaults = { arn = "arn:aws:kafka:ap-south-1:123456789012:configuration/mock/00000000-0000-0000-0000-000000000000-1" } }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
  mock_resource "aws_rds_cluster" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
}

variables {
  name        = "acme-prod-aps1"
  subnet_ids  = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb", "subnet-0cccccccccccccccc"]
  kms_key_arn = "arn:aws:kms:ap-south-1:123456789012:key/test"
}

run "aurora_is_private_encrypted_and_follows_version_18" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    deployment                 = "aurora"
    postgres_major_version     = "18"
    read_replicas              = 1
    deletion_protection        = true
  }

  assert {
    condition     = aws_rds_cluster.this[0].storage_encrypted && aws_rds_cluster.this[0].deletion_protection
    error_message = "Aurora storage must be encrypted and protected in prod."
  }

  assert {
    condition     = length(aws_rds_cluster_instance.this) == 2 && alltrue([for i in aws_rds_cluster_instance.this : i.publicly_accessible == false])
    error_message = "Aurora writer and readers must all be private."
  }

  assert {
    condition     = aws_rds_cluster_parameter_group.this[0].family == "aurora-postgresql18"
    error_message = "The cluster parameter group family must follow postgres_major_version."
  }

  assert {
    condition     = length(aws_db_instance.this) == 0
    error_message = "Aurora must not also create an RDS instance."
  }
}

run "aurora_follows_version_19" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    deployment                 = "aurora"
    postgres_major_version     = "19"
  }

  assert {
    condition     = aws_rds_cluster_parameter_group.this[0].family == "aurora-postgresql19" && data.aws_rds_engine_version.aurora[0].version == "19"
    error_message = "Engine version and family must follow postgres_major_version."
  }
}

run "multi_az_rds_with_replicas" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    postgres_major_version     = "18"
    multi_az                   = true
    read_replicas              = 2
  }

  assert {
    condition     = aws_db_instance.this[0].multi_az && length(aws_db_instance.replica) == 2
    error_message = "Scale RDS must be Multi-AZ with read replicas."
  }

  assert {
    condition     = alltrue([for r in concat(aws_db_instance.this, aws_db_instance.replica) : r.publicly_accessible == false && r.storage_encrypted == true])
    error_message = "Every RDS instance must be private and encrypted."
  }
}

run "self_managed_creates_no_database" {
  command = plan

  module {
    source = "../../modules/database"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    deployment                 = "self-managed"
    postgres_major_version     = "19"
  }

  assert {
    condition     = length(aws_db_instance.this) == 0 && length(aws_rds_cluster.this) == 0 && length(aws_security_group.this) == 0
    error_message = "Self-managed mode must not create managed database resources."
  }
}

run "opensearch_is_vpc_only_encrypted_with_fine_grained_access" {
  command = plan

  module {
    source = "../../modules/search"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    region                     = "ap-south-1"
  }

  assert {
    condition = (
      aws_opensearch_domain.this.encrypt_at_rest[0].enabled
      && aws_opensearch_domain.this.node_to_node_encryption[0].enabled
      && aws_opensearch_domain.this.domain_endpoint_options[0].enforce_https
    )
    error_message = "OpenSearch must encrypt at rest, between nodes and enforce HTTPS."
  }

  assert {
    condition     = aws_opensearch_domain.this.advanced_security_options[0].enabled && !aws_opensearch_domain.this.advanced_security_options[0].anonymous_auth_enabled
    error_message = "Fine-grained access control must be on, without anonymous access."
  }

  assert {
    condition     = aws_opensearch_domain.this.cluster_config[0].zone_awareness_enabled && aws_opensearch_domain.this.cluster_config[0].zone_awareness_config[0].availability_zone_count == 3
    error_message = "OpenSearch must span three AZs."
  }

  assert {
    condition     = length(aws_opensearch_domain.this.vpc_options[0].subnet_ids) == 3 && length(aws_opensearch_domain.this.domain_name) <= 28
    error_message = "OpenSearch must be VPC-only with a valid domain name."
  }

  assert {
    condition = alltrue(flatten([
      for d in [data.aws_iam_policy_document.access, data.aws_iam_policy_document.admin_trust] : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "OpenSearch policies must not use wildcard actions."
  }
}

run "msk_encrypts_and_stays_private" {
  command = plan

  module {
    source = "../../modules/streaming"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
  }

  assert {
    condition = (
      aws_msk_cluster.this.encryption_info[0].encryption_in_transit[0].client_broker == "TLS"
      && aws_msk_cluster.this.encryption_info[0].encryption_in_transit[0].in_cluster
      && aws_msk_cluster.this.encryption_info[0].encryption_at_rest_kms_key_arn == "arn:aws:kms:ap-south-1:123456789012:key/test"
    )
    error_message = "MSK must use TLS in transit and the stack's KMS key at rest."
  }

  assert {
    condition     = aws_msk_cluster.this.number_of_broker_nodes == 3 && strcontains(aws_msk_configuration.this.server_properties, "default.replication.factor=3")
    error_message = "One broker per AZ with replication factor 3."
  }
}

run "valkey_cluster_mode_is_encrypted" {
  command = plan

  module {
    source = "../../modules/cache"
  }

  variables {
    vpc_id                     = "vpc-0123456789abcdef0"
    allowed_security_group_ids = ["sg-0123456789abcdef0"]
    cluster_mode               = true
    shards                     = 2
    replicas                   = 1
  }

  assert {
    condition = (
      aws_elasticache_replication_group.this.cluster_mode == "enabled"
      && aws_elasticache_replication_group.this.parameter_group_name == "default.valkey8.cluster.on"
      && aws_elasticache_replication_group.this.automatic_failover_enabled
      && aws_elasticache_replication_group.this.multi_az_enabled
    )
    error_message = "Cluster mode needs the cluster parameter group, failover and Multi-AZ."
  }

  assert {
    condition     = aws_elasticache_replication_group.this.at_rest_encryption_enabled == "true" && aws_elasticache_replication_group.this.transit_encryption_enabled
    error_message = "Valkey must encrypt at rest and in transit."
  }
}

run "karpenter_policies_name_their_actions" {
  command = plan

  module {
    source = "../../modules/eks"
  }

  variables {
    region                = "ap-south-1"
    enable_karpenter      = true
    alb_security_group_id = "sg-0123456789abcdef0"
    target_group_arns     = ["arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/acme-web/0123456789abcdef"]
  }

  assert {
    condition     = length(aws_cloudwatch_event_rule.karpenter) == 4 && length(aws_eks_pod_identity_association.this) == 2
    error_message = "Karpenter needs its interruption rules and a Pod Identity association."
  }

  assert {
    condition = alltrue(flatten([
      for d in concat(data.aws_iam_policy_document.karpenter, data.aws_iam_policy_document.karpenter_queue) : [
        for s in d.statement : [for a in s.actions : !strcontains(a, "*")] if s.effect != "Deny"
      ]
    ]))
    error_message = "Karpenter policies must not use wildcard actions."
  }
}
