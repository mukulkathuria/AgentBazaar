# AWS Backup: daily recovery points of the database, copied to a second region for disaster recovery.

data "aws_partition" "current" {}

# KMS keys are regional: the copy vault needs its own key in backup_copy_region.
module "kms_backup_copy" {
  source = "../../modules/secrets-kms"
  providers = {
    aws = aws.backup_copy
  }
  name          = "${module.naming.prefix}-backup"
  region        = var.backup_copy_region
  secret_prefix = module.naming.secret_prefix
}

data "aws_iam_policy_document" "backup_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${module.naming.prefix}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_trust.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each   = toset(["AWSBackupServiceRolePolicyForBackup", "AWSBackupServiceRolePolicyForRestores"])
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/${each.key}"
}

resource "aws_backup_vault" "primary" {
  name        = module.naming.prefix
  kms_key_arn = module.kms.key_arn
}

resource "aws_backup_vault" "copy" {
  provider    = aws.backup_copy
  name        = "${module.naming.prefix}-copy"
  kms_key_arn = module.kms_backup_copy.key_arn

  lifecycle {
    precondition {
      condition     = var.backup_copy_region != var.region
      error_message = "backup_copy_region must be a different region than region."
    }
  }
}

resource "aws_backup_plan" "this" {
  name = module.naming.prefix

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = var.backup_schedule

    lifecycle {
      delete_after = var.backup_retention_days
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.copy.arn

      lifecycle {
        delete_after = var.backup_retention_days
      }
    }
  }
}

resource "aws_backup_selection" "database" {
  count        = var.database_deployment == "self-managed" ? 0 : 1
  name         = "${module.naming.prefix}-database"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [module.database.arn]
}
