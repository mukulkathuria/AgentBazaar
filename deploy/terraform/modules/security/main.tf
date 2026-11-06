variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for CloudTrail files and AWS Config deliveries."
  type        = string
}

variable "logs_bucket_name" {
  description = "Log bucket (its policy must already allow CloudTrail when enable_cloudtrail is true)."
  type        = string
}

variable "enable_cloudtrail" {
  description = "Multi-region CloudTrail trail with log file validation."
  type        = bool
  default     = false
}

variable "enable_guardduty" {
  description = "GuardDuty detector (one per account and region: disable if your organisation already manages it)."
  type        = bool
  default     = false
}

variable "enable_securityhub" {
  description = "Security Hub with the default standards (needs AWS Config recording for most controls)."
  type        = bool
  default     = false
}

variable "enable_config" {
  description = "AWS Config recorder delivering to the log bucket (one recorder per account and region)."
  type        = bool
  default     = false
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  bucket_arn = "arn:${local.partition}:s3:::${var.logs_bucket_name}"
}

resource "aws_cloudtrail" "this" {
  count                         = var.enable_cloudtrail ? 1 : 0
  name                          = "${var.name}-trail"
  s3_bucket_name                = var.logs_bucket_name
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  kms_key_id                    = var.kms_key_arn
}

resource "aws_guardduty_detector" "this" {
  count  = var.enable_guardduty ? 1 : 0
  enable = true
}

resource "aws_securityhub_account" "this" {
  count                    = var.enable_securityhub ? 1 : 0
  enable_default_standards = true
}

data "aws_iam_policy_document" "config_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "config_delivery" {
  statement {
    sid       = "WriteSnapshots"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*"]
  }

  statement {
    sid       = "CheckBucket"
    actions   = ["s3:GetBucketAcl"]
    resources = [local.bucket_arn]
  }

  statement {
    sid       = "EncryptSnapshots"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role" "config" {
  count              = var.enable_config ? 1 : 0
  name               = "${var.name}-config"
  assume_role_policy = data.aws_iam_policy_document.config_trust.json
}

resource "aws_iam_role_policy_attachment" "config" {
  count      = var.enable_config ? 1 : 0
  role       = aws_iam_role.config[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_iam_role_policy" "config" {
  count  = var.enable_config ? 1 : 0
  name   = "delivery"
  role   = aws_iam_role.config[0].id
  policy = data.aws_iam_policy_document.config_delivery.json
}

resource "aws_config_configuration_recorder" "this" {
  count    = var.enable_config ? 1 : 0
  name     = var.name
  role_arn = aws_iam_role.config[0].arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "this" {
  count          = var.enable_config ? 1 : 0
  name           = var.name
  s3_bucket_name = var.logs_bucket_name
  s3_kms_key_arn = var.kms_key_arn

  depends_on = [aws_config_configuration_recorder.this, aws_iam_role_policy.config]
}

resource "aws_config_configuration_recorder_status" "this" {
  count      = var.enable_config ? 1 : 0
  name       = aws_config_configuration_recorder.this[0].name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.this]
}

output "trail_arn" {
  description = "CloudTrail ARN, or null."
  value       = one(aws_cloudtrail.this[*].arn)
}

output "guardduty_detector_id" {
  description = "GuardDuty detector ID, or null."
  value       = one(aws_guardduty_detector.this[*].id)
}

output "enabled_controls" {
  description = "Which account-level controls this stack manages."
  value = {
    cloudtrail  = var.enable_cloudtrail
    guardduty   = var.enable_guardduty
    securityhub = var.enable_securityhub
    config      = var.enable_config
  }
}
