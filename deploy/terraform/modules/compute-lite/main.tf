data "aws_partition" "current" {}

locals {
  # Graviton families carry a "g" after the generation number (t4g, m7g, c8gd, ...).
  arch          = can(regex("^[a-z]+[0-9]+g[a-z]*\\.", var.instance_type)) ? "arm64" : "amd64"
  ami_parameter = coalesce(var.ami_ssm_parameter, "/aws/service/canonical/ubuntu/server/24.04/stable/current/${local.arch}/hvm/ebs-gp3/ami-id")
}

data "aws_ssm_parameter" "ami" {
  name = local.ami_parameter
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "ReadAppSecret"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [var.app_secret_arn]
  }

  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }

  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListBucket"]
    resources = var.s3_bucket_arns
  }

  statement {
    sid       = "ReadWriteObjects"
    actions   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
    resources = [for arn in var.s3_bucket_arns : "${arn}/*"]
  }

  statement {
    sid       = "ShipContainerLogs"
    actions   = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
    resources = ["${var.log_group_arn}:*"]
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.name}-host"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Session Manager shell and Run Command (upgrades) without opening port 22.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "host" {
  name   = "host"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-host"
  role = aws_iam_role.this.name
}

# Lives apart from the instance so data survives instance replacement; destroy leaves a snapshot.
resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.kms_key_arn
  final_snapshot    = true
  tags              = { Name = "${var.name}-data" }
}

resource "aws_instance" "this" {
  ami                     = data.aws_ssm_parameter.ami.insecure_value
  instance_type           = var.instance_type
  subnet_id               = var.subnet_id
  vpc_security_group_ids  = var.security_group_ids
  iam_instance_profile    = aws_iam_instance_profile.this.name
  key_name                = var.ssh_key_name
  disable_api_termination = var.termination_protection

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    volume_serial   = replace(aws_ebs_volume.data.id, "-", "")
    region          = var.region
    log_group_name  = var.log_group_name
    repo_url        = var.repo_url
    app_version     = var.app_version
    secret_arn      = var.app_secret_arn
    compose_profile = var.compose_profile
    compose_file    = var.compose_file
    app_env         = var.app_env
  })

  # IMDSv2 only; hop limit 1 keeps containers on the bridge network away from instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
    kms_key_id  = var.kms_key_arn
  }

  tags = { Name = var.name }

  # Bootstrap runs once. A newer AMI or edited user data must not replace a running shop;
  # upgrade in place with `agentbazaar-deploy <ref>` (see the README).
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.this.id
  stop_instance_before_detaching = true
}

resource "aws_eip" "this" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_eip_association" "this" {
  allocation_id = aws_eip.this.id
  instance_id   = aws_instance.this.id
}
