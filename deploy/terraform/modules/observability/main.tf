data "aws_partition" "current" {}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(var.log_groups)
  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = var.alarms
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  treat_missing_data  = each.value.treat_missing_data
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_prometheus_workspace" "this" {
  count = var.enable_managed_prometheus ? 1 : 0
  alias = var.name
}

data "aws_iam_policy_document" "grafana_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["grafana.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "grafana" {
  count              = var.enable_managed_grafana ? 1 : 0
  name               = "${var.name}-grafana"
  assume_role_policy = data.aws_iam_policy_document.grafana_trust.json
}

resource "aws_iam_role_policy_attachment" "grafana" {
  for_each   = var.enable_managed_grafana ? toset(["AmazonPrometheusQueryAccess", "CloudWatchReadOnlyAccess"]) : toset([])
  role       = aws_iam_role.grafana[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/${each.key}"
}

resource "aws_grafana_workspace" "this" {
  count                    = var.enable_managed_grafana ? 1 : 0
  name                     = var.name
  account_access_type      = "CURRENT_ACCOUNT"
  authentication_providers = ["AWS_SSO"]
  permission_type          = "SERVICE_MANAGED"
  role_arn                 = aws_iam_role.grafana[0].arn
  data_sources             = ["CLOUDWATCH", "PROMETHEUS"]
}
