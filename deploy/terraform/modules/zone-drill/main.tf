# An AWS FIS experiment template that takes one availability zone down, after AWS's "AZ Availability: Power
# Interruption" scenario: the zone's subnets lose all connectivity, the cluster's nodes there stop, the database
# fails over and the cache loses its nodes in the zone. The template costs nothing until someone starts it
# (docs/runbooks/scale-load-and-zone-drill.md); every target is named by ARN or by its own cluster tag, so a run
# cannot touch another stack in the account.

locals {
  duration = "PT10M"
  databases = {
    rds    = { action = "aws:rds:reboot-db-instances", type = "aws:rds:db", target = "DBInstances", parameters = { forceFailover = "true" } }
    aurora = { action = "aws:rds:failover-db-cluster", type = "aws:rds:cluster", target = "Clusters", parameters = {} }
  }
  database = lookup(local.databases, var.database_deployment, null)
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["fis.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fis" {
  name               = "${var.name}-zone-drill"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy_attachment" "fis" {
  for_each   = toset(["AWSFaultInjectionSimulatorNetworkAccess", "AWSFaultInjectionSimulatorEC2Access", "AWSFaultInjectionSimulatorRDSAccess"])
  role       = aws_iam_role.fis.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/${each.key}"
}

data "aws_iam_policy_document" "cache" {
  statement {
    actions   = ["elasticache:InterruptClusterAzPower", "elasticache:DescribeReplicationGroups"]
    resources = [var.cache_arn]
  }

  statement {
    actions   = ["tag:GetResources"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "cache" {
  name   = "elasticache-az-power"
  role   = aws_iam_role.fis.id
  policy = data.aws_iam_policy_document.cache.json
}

# Safety stop: the drill aborts if the store visibly breaks (10x the 0.1% error budget for three minutes).
resource "aws_cloudwatch_metric_alarm" "abort" {
  alarm_name          = "${var.name}-zone-drill-abort"
  alarm_description   = "Stops the zone-failure drill: more than 1% of ALB requests failed with 5xx for three minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.01
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "share"
    expression  = "(FILL(elb, 0) + FILL(target, 0)) / requests"
    label       = "5xx share of ALB requests"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { requests = "RequestCount", elb = "HTTPCode_ELB_5XX_Count", target = "HTTPCode_Target_5XX_Count" }
    content {
      id = metric_query.key

      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = metric_query.value
        dimensions  = { LoadBalancer = var.alb_arn_suffix }
        period      = 60
        stat        = "Sum"
      }
    }
  }
}

resource "aws_fis_experiment_template" "zone" {
  description = "Zone failure drill: ${var.az} down for ${local.duration}"
  role_arn    = aws_iam_role.fis.arn
  tags        = { Name = "${var.name}-zone-drill" }

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = aws_cloudwatch_metric_alarm.abort.arn
  }

  experiment_options {
    account_targeting            = "single-account"
    empty_target_resolution_mode = "skip"
  }

  action {
    name      = "disrupt-network"
    action_id = "aws:network:disrupt-connectivity"

    parameter {
      key   = "duration"
      value = local.duration
    }

    parameter {
      key   = "scope"
      value = "all"
    }

    target {
      key   = "Subnets"
      value = "subnets"
    }
  }

  action {
    name      = "stop-nodes"
    action_id = "aws:ec2:stop-instances"

    parameter {
      key   = "startInstancesAfterDuration"
      value = local.duration
    }

    target {
      key   = "Instances"
      value = "nodes"
    }
  }

  action {
    name      = "interrupt-cache"
    action_id = "aws:elasticache:replicationgroup-interrupt-az-power"

    parameter {
      key   = "duration"
      value = local.duration
    }

    target {
      key   = "ReplicationGroups"
      value = "cache"
    }
  }

  dynamic "action" {
    for_each = local.database == null ? [] : [local.database]
    content {
      name      = "fail-over-database"
      action_id = action.value.action

      dynamic "parameter" {
        for_each = action.value.parameters
        content {
          key   = parameter.key
          value = parameter.value
        }
      }

      target {
        key   = action.value.target
        value = "database"
      }
    }
  }

  target {
    name           = "subnets"
    resource_type  = "aws:ec2:subnet"
    selection_mode = "ALL"
    resource_arns  = [for id in var.subnet_ids : "arn:${data.aws_partition.current.partition}:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:subnet/${id}"]
  }

  target {
    name           = "nodes"
    resource_type  = "aws:ec2:instance"
    selection_mode = "ALL"

    resource_tag {
      key   = "kubernetes.io/cluster/${var.cluster_name}"
      value = "owned"
    }

    filter {
      path   = "Placement.AvailabilityZone"
      values = [var.az]
    }

    filter {
      path   = "State.Name"
      values = ["running"]
    }
  }

  target {
    name           = "cache"
    resource_type  = "aws:elasticache:replicationgroup"
    selection_mode = "ALL"
    resource_arns  = [var.cache_arn]
    parameters     = { availabilityZoneIdentifier = var.az }
  }

  dynamic "target" {
    for_each = local.database == null ? [] : [local.database]
    content {
      name           = "database"
      resource_type  = target.value.type
      selection_mode = "ALL"
      resource_arns  = [var.database_arn]
    }
  }
}
