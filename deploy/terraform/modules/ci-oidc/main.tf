variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the role, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}

variable "subjects" {
  description = "Allowed OIDC subjects after repo:<owner/name>: e.g. ref:refs/heads/main or environment:prod."
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub OIDC provider. Set false if the account already has one."
  type        = bool
  default     = true
}

variable "policy_statements" {
  description = "Least-privilege permissions for the CI role. Wildcard actions are rejected."
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.policy_statements : alltrue([for a in s.actions : !strcontains(a, "*")])])
    error_message = "policy_statements must list explicit actions; wildcards (\"*\") are not allowed."
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  issuer       = "token.actions.githubusercontent.com"
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.issuer}"
}

# No thumbprint: AWS validates GitHub's certificate chain itself, so nothing pins a rotating CA.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://${local.issuer}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "${local.issuer}:sub"
      values   = [for s in var.subjects : "repo:${var.github_repository}:${s}"]
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = "${var.name}-ci"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "permissions" {
  dynamic "statement" {
    for_each = var.policy_statements
    content {
      sid       = statement.value.sid
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  count  = length(var.policy_statements) > 0 ? 1 : 0
  name   = "deploy"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.permissions.json
}

output "role_arn" {
  description = "Role GitHub Actions assumes (aws-actions/configure-aws-credentials role-to-assume)."
  value       = aws_iam_role.ci.arn
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN."
  value       = local.provider_arn
}
