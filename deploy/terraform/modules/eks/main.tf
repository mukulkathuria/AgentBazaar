data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_default_tags" "current" {}

locals {
  account         = data.aws_caller_identity.current.account_id
  partition       = data.aws_partition.current.partition
  public_endpoint = length(var.admin_cidrs) > 0
  node_policies   = ["AmazonEKSWorkerNodePolicy", "AmazonEKS_CNI_Policy", "AmazonEC2ContainerRegistryPullOnly"]

  # EKS Pod Identity roles: <key> => service account that assumes it.
  pod_roles = merge(
    {
      "ebs-csi"       = { namespace = "kube-system", service_account = "ebs-csi-controller-sa" }
      "lb-controller" = { namespace = "kube-system", service_account = "aws-load-balancer-controller" }
    },
    var.enable_karpenter ? { karpenter = { namespace = "kube-system", service_account = "karpenter" } } : {},
  )
}

data "aws_iam_policy_document" "cluster_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "pod_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- control plane

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_trust.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "cluster_kms" {
  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:ListGrants"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "cluster_kms" {
  name   = "secrets-encryption"
  role   = aws_iam_role.cluster.id
  policy = data.aws_iam_policy_document.cluster_kms.json
}

# Created up front so the log group gets KMS encryption and a retention instead of EKS's defaults.
resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_eks_cluster" "this" {
  name                      = var.name
  version                   = var.kubernetes_version
  role_arn                  = aws_iam_role.cluster.arn
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  deletion_protection       = var.deletion_protection

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  encryption_config {
    resources = ["secrets"]

    provider {
      key_arn = var.kms_key_arn
    }
  }

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = local.public_endpoint
    public_access_cidrs     = local.public_endpoint ? var.admin_cidrs : null
  }

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_iam_role_policy.cluster_kms, aws_cloudwatch_log_group.cluster]
}

resource "aws_eks_access_entry" "admin" {
  for_each      = toset(var.admin_role_arns)
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.key
}

resource "aws_eks_access_policy_association" "admin" {
  for_each      = toset(var.admin_role_arns)
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.key
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.admin]
}

resource "aws_eks_access_entry" "deployer" {
  for_each      = var.namespace_deployers
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
}

resource "aws_eks_access_policy_association" "deployer" {
  for_each      = var.namespace_deployers
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope {
    type       = "namespace"
    namespaces = [var.app_namespace]
  }

  depends_on = [aws_eks_access_entry.deployer]
}

# Nodes carry the cluster security group; open only the app ports, only from the ALB.
resource "aws_vpc_security_group_ingress_rule" "alb_to_pods" {
  for_each                     = toset([for p in var.app_ports : tostring(p)])
  security_group_id            = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  referenced_security_group_id = var.alb_security_group_id
  description                  = "ALB to app pods"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
}

# ---------------------------------------------------------------- managed node group

resource "aws_iam_role" "node" {
  name               = "${var.name}-eks-node"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each   = toset(local.node_policies)
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.key}"
}

resource "aws_launch_template" "node" {
  name                   = "${var.name}-eks-node"
  update_default_version = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = var.node_metadata_hop_limit
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.node_disk_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  # default_tags do not reach instances an Auto Scaling group launches; copy them explicitly.
  dynamic "tag_specifications" {
    for_each = ["instance", "volume"]
    content {
      resource_type = tag_specifications.value
      tags          = merge(data.aws_default_tags.current.tags, { Name = "${var.name}-node" })
    }
  }
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  ami_type        = var.node_ami_type
  instance_types  = var.node_instance_types
  capacity_type   = var.node_capacity_type

  scaling_config {
    min_size     = var.node_min
    desired_size = var.node_desired
    max_size     = var.node_max
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  depends_on = [aws_iam_role_policy_attachment.node]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# ---------------------------------------------------------------- add-ons and pod identities

resource "aws_iam_role" "pod" {
  for_each           = local.pod_roles
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_eks_addon" "this" {
  for_each                    = toset(["vpc-cni", "kube-proxy", "coredns", "eks-pod-identity-agent", "aws-ebs-csi-driver"])
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.key
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  dynamic "pod_identity_association" {
    for_each = each.key == "aws-ebs-csi-driver" ? [local.pod_roles["ebs-csi"]] : []
    content {
      role_arn        = aws_iam_role.pod["ebs-csi"].arn
      service_account = pod_identity_association.value.service_account
    }
  }

  depends_on = [aws_eks_node_group.default]
}

resource "aws_eks_pod_identity_association" "this" {
  for_each        = { for k, v in local.pod_roles : k => v if k != "ebs-csi" }
  cluster_name    = aws_eks_cluster.this.name
  namespace       = each.value.namespace
  service_account = each.value.service_account
  role_arn        = aws_iam_role.pod[each.key].arn
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.pod["ebs-csi"].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# Lets the driver create volumes encrypted with this stack's key (StorageClass kmsKeyId).
data "aws_iam_policy_document" "ebs_csi_kms" {
  statement {
    sid       = "UseKey"
    resources = [var.kms_key_arn]
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
  }

  statement {
    sid       = "GrantsForEbs"
    resources = [var.kms_key_arn]
    actions   = ["kms:CreateGrant", "kms:ListGrants", "kms:RevokeGrant"]

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "ebs_csi_kms" {
  name   = "kms"
  role   = aws_iam_role.pod["ebs-csi"].id
  policy = data.aws_iam_policy_document.ebs_csi_kms.json
}

# AWS Load Balancer Controller, scoped to TargetGroupBinding on this stack's target groups.
data "aws_iam_policy_document" "lb_controller" {
  statement {
    sid       = "Discover"
    resources = ["*"]
    actions = [
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeInstances",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
      "elasticloadbalancing:DescribeListeners",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeRules",
      "elasticloadbalancing:DescribeTags",
      "elasticloadbalancing:DescribeTargetGroupAttributes",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
    ]
  }

  statement {
    sid       = "RegisterPods"
    resources = var.target_group_arns
    actions   = ["elasticloadbalancing:DeregisterTargets", "elasticloadbalancing:RegisterTargets"]
  }
}

resource "aws_iam_role_policy" "lb_controller" {
  name   = "target-group-binding"
  role   = aws_iam_role.pod["lb-controller"].id
  policy = data.aws_iam_policy_document.lb_controller.json
}

# ---------------------------------------------------------------- Karpenter (optional)

resource "aws_iam_role" "karpenter_node" {
  count              = var.enable_karpenter ? 1 : 0
  name               = "${var.name}-karpenter-node"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "karpenter_node" {
  for_each   = var.enable_karpenter ? toset(local.node_policies) : toset([])
  role       = aws_iam_role.karpenter_node[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.key}"
}

resource "aws_eks_access_entry" "karpenter_node" {
  count         = var.enable_karpenter ? 1 : 0
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_iam_role.karpenter_node[0].arn
  type          = "EC2_LINUX"
}

resource "aws_sqs_queue" "karpenter" {
  count                     = var.enable_karpenter ? 1 : 0
  name                      = "${var.name}-karpenter"
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "karpenter_queue" {
  count = var.enable_karpenter ? 1 : 0

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.karpenter[0].arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "sqs.amazonaws.com"]
    }
  }
}

resource "aws_sqs_queue_policy" "karpenter" {
  count     = var.enable_karpenter ? 1 : 0
  queue_url = aws_sqs_queue.karpenter[0].url
  policy    = data.aws_iam_policy_document.karpenter_queue[0].json
}

locals {
  karpenter_events = {
    health    = { source = ["aws.health"], "detail-type" = ["AWS Health Event"] }
    spot      = { source = ["aws.ec2"], "detail-type" = ["EC2 Spot Instance Interruption Warning"] }
    rebalance = { source = ["aws.ec2"], "detail-type" = ["EC2 Instance Rebalance Recommendation"] }
    state     = { source = ["aws.ec2"], "detail-type" = ["EC2 Instance State-change Notification"] }
  }
}

resource "aws_cloudwatch_event_rule" "karpenter" {
  for_each      = { for k, v in local.karpenter_events : k => v if var.enable_karpenter }
  name          = "${var.name}-karpenter-${each.key}"
  event_pattern = jsonencode(each.value)
}

resource "aws_cloudwatch_event_target" "karpenter" {
  for_each = aws_cloudwatch_event_rule.karpenter
  rule     = each.value.name
  arn      = aws_sqs_queue.karpenter[0].arn
}

data "aws_iam_policy_document" "karpenter" {
  count = var.enable_karpenter ? 1 : 0

  statement {
    sid       = "Discover"
    resources = ["*"]
    actions = [
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeCapacityReservations",
      "ec2:DescribeImages",
      "ec2:DescribeInstanceTypeOfferings",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeInstances",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSpotPriceHistory",
      "ec2:DescribeSubnets",
      "pricing:GetProducts",
    ]
  }

  statement {
    sid       = "LaunchNodes"
    resources = ["*"]
    actions   = ["ec2:CreateFleet", "ec2:CreateLaunchTemplate", "ec2:CreateTags", "ec2:RunInstances"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid       = "RemoveOwnNodes"
    resources = ["*"]
    actions   = ["ec2:DeleteLaunchTemplate", "ec2:TerminateInstances"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/kubernetes.io/cluster/${var.name}"
      values   = ["owned"]
    }
  }

  statement {
    sid       = "PassNodeRole"
    resources = [aws_iam_role.karpenter_node[0].arn]
    actions   = ["iam:PassRole"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  statement {
    sid       = "InstanceProfiles"
    resources = ["arn:${local.partition}:iam::${local.account}:instance-profile/*"]
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:ListInstanceProfiles",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
    ]
  }

  statement {
    sid       = "PublicAmiParameters"
    resources = ["arn:${local.partition}:ssm:${var.region}::parameter/aws/service/*"]
    actions   = ["ssm:GetParameter"]
  }

  statement {
    sid       = "Cluster"
    resources = [aws_eks_cluster.this.arn]
    actions   = ["eks:DescribeCluster"]
  }

  statement {
    sid       = "Interruptions"
    resources = [aws_sqs_queue.karpenter[0].arn]
    actions   = ["sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:ReceiveMessage"]
  }
}

resource "aws_iam_role_policy" "karpenter" {
  count  = var.enable_karpenter ? 1 : 0
  name   = "controller"
  role   = aws_iam_role.pod["karpenter"].id
  policy = data.aws_iam_policy_document.karpenter[0].json
}

# Karpenter's EC2NodeClass selects subnets and security groups by this tag.
resource "aws_ec2_tag" "karpenter_sg" {
  count       = var.enable_karpenter ? 1 : 0
  resource_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  key         = "karpenter.sh/discovery"
  value       = var.name
}
