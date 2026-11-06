variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "region" {
  description = "AWS region of the domain."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the domain (VPC access only, no public endpoint)."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets, one per AZ; the first az_count are used."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach the domain on 443."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key for encryption at rest."
  type        = string
}

variable "engine_version" {
  description = "OpenSearch engine version."
  type        = string
  default     = "OpenSearch_2.19"
}

variable "instance_type" {
  description = "Data node instance type (Graviton by default)."
  type        = string
  default     = "r7g.large.search"
}

variable "instance_count" {
  description = "Data nodes; a multiple of az_count so every AZ holds a copy."
  type        = number
  default     = 3
}

variable "az_count" {
  description = "AZs the domain spans (2 or 3)."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (multi-AZ)."
  }
}

variable "dedicated_master" {
  description = "Three dedicated cluster-manager nodes."
  type        = bool
  default     = true
}

variable "master_instance_type" {
  description = "Dedicated cluster-manager instance type."
  type        = string
  default     = "m7g.large.search"
}

variable "volume_gb" {
  description = "gp3 volume per data node."
  type        = number
  default     = 100
}

variable "master_user_arn" {
  description = "IAM principal mapped to the fine-grained-access admin (null: create an admin role assumable from this account)."
  type        = string
  default     = null
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account      = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  domain       = trimsuffix(substr("${var.name}-search", 0, 28), "-")
  create_admin = var.master_user_arn == null
}

data "aws_iam_policy_document" "admin_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
}

resource "aws_iam_role" "admin" {
  count              = local.create_admin ? 1 : 0
  name               = "${var.name}-search-admin"
  assume_role_policy = data.aws_iam_policy_document.admin_trust.json
}

resource "aws_security_group" "this" {
  name        = "${var.name}-search"
  description = "OpenSearch HTTPS from app workloads only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-search" }
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  count                        = length(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.allowed_security_group_ids[count.index]
  description                  = "OpenSearch from app workloads"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

# IAM principals of this account may send signed requests; fine-grained access control decides what they can do.
data "aws_iam_policy_document" "access" {
  statement {
    resources = ["arn:${local.partition}:es:${var.region}:${local.account}:domain/${local.domain}/*"]
    actions = [
      "es:ESHttpDelete",
      "es:ESHttpGet",
      "es:ESHttpHead",
      "es:ESHttpPatch",
      "es:ESHttpPost",
      "es:ESHttpPut",
    ]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
}

resource "aws_opensearch_domain" "this" {
  domain_name     = local.domain
  engine_version  = var.engine_version
  access_policies = data.aws_iam_policy_document.access.json

  cluster_config {
    instance_type            = var.instance_type
    instance_count           = var.instance_count
    zone_awareness_enabled   = true
    dedicated_master_enabled = var.dedicated_master
    dedicated_master_type    = var.dedicated_master ? var.master_instance_type : null
    dedicated_master_count   = var.dedicated_master ? 3 : null

    zone_awareness_config {
      availability_zone_count = var.az_count
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.volume_gb
  }

  encrypt_at_rest {
    enabled    = true
    kms_key_id = var.kms_key_arn
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-PFS-2023-10"
  }

  advanced_security_options {
    enabled                        = true
    anonymous_auth_enabled         = false
    internal_user_database_enabled = false

    master_user_options {
      master_user_arn = local.create_admin ? aws_iam_role.admin[0].arn : var.master_user_arn
    }
  }

  vpc_options {
    subnet_ids         = slice(var.subnet_ids, 0, var.az_count)
    security_group_ids = [aws_security_group.this.id]
  }

  software_update_options {
    auto_software_update_enabled = true
  }
}

output "url" {
  description = "OPENSEARCH_URL for the app (requests must be SigV4-signed: fine-grained access control is on)."
  value       = "https://${aws_opensearch_domain.this.endpoint}"
}

output "domain_arn" {
  description = "OpenSearch domain ARN."
  value       = aws_opensearch_domain.this.arn
}

output "admin_role_arn" {
  description = "Fine-grained-access admin role created here, or null when master_user_arn was supplied."
  value       = one(aws_iam_role.admin[*].arn)
}
