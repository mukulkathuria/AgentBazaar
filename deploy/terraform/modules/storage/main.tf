data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket" "this" {
  for_each      = var.buckets
  bucket        = "${var.name}-${local.account}-${each.key}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    id     = "default"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.buckets[each.key].noncurrent_expire_days
    }

    dynamic "transition" {
      for_each = var.buckets[each.key].transition_ia_days == null ? [] : [var.buckets[each.key].transition_ia_days]
      content {
        days          = transition.value
        storage_class = "STANDARD_IA"
      }
    }

    dynamic "expiration" {
      for_each = var.buckets[each.key].expire_days == null ? [] : [var.buckets[each.key].expire_days]
      content {
        days = expiration.value
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "bucket" {
  for_each = aws_s3_bucket.this

  # Restrictive statement: s3:* is the point here (deny every action over plain HTTP).
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = each.key == var.cdn_bucket ? [1] : []
    content {
      sid       = "CloudFrontRead"
      actions   = ["s3:GetObject"]
      resources = ["${each.value.arn}/*"]

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [var.cloudfront_distribution_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == var.cloudtrail_bucket ? [1] : []
    content {
      sid       = "CloudTrailAclCheck"
      actions   = ["s3:GetBucketAcl"]
      resources = [each.value.arn]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == var.cloudtrail_bucket ? [1] : []
    content {
      sid       = "CloudTrailWrite"
      actions   = ["s3:PutObject"]
      resources = ["${each.value.arn}/AWSLogs/${local.account}/*"]

      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "s3:x-amz-acl"
        values   = ["bucket-owner-full-control"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
