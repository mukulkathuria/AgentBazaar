data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
}

# Explicit action lists instead of kms:* keep the policy reviewable; IAM policies in this account
# can still delegate these actions (RDS, EBS, S3, MSK, ... use the caller's permissions).
data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountAdministrationAndUse"
    resources = ["*"]
    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:DisableKeyRotation",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListGrants",
      "kms:ListKeyPolicies",
      "kms:ListKeyRotations",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
      "kms:RetireGrant",
      "kms:RevokeGrant",
      "kms:RotateKeyOnDemand",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }

  statement {
    sid       = "CloudWatchLogs"
    resources = ["*"]
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${var.region}:${local.account}:log-group:*"]
    }
  }

  # CloudWatch alarms publish to the KMS-encrypted alarm topic.
  statement {
    sid       = "CloudWatchAlarmsToSns"
    resources = ["*"]
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }

  dynamic "statement" {
    for_each = var.allow_cloudtrail ? [1] : []
    content {
      sid       = "CloudTrailEncrypt"
      resources = ["*"]
      actions   = ["kms:GenerateDataKey"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringLike"
        variable = "kms:EncryptionContext:aws:cloudtrail:arn"
        values   = ["arn:${local.partition}:cloudtrail:*:${local.account}:trail/*"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.allow_cloudtrail ? [1] : []
    content {
      sid       = "CloudTrailDescribe"
      resources = ["*"]
      actions   = ["kms:DescribeKey"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.allow_cloudfront ? [1] : []
    content {
      sid       = "CloudFrontReadMedia"
      resources = ["*"]
      actions   = ["kms:Decrypt"]

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = ["arn:${local.partition}:cloudfront::${local.account}:distribution/*"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "${var.name}: data at rest, logs and secrets"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_days
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

# Placeholders only: no aws_secretsmanager_secret_version, so no secret value ever lands in code or state.
resource "aws_secretsmanager_secret" "this" {
  for_each                = var.secrets
  name                    = "${var.secret_prefix}/${each.key}"
  description             = each.value
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.secret_recovery_days
}
