# The zone-failure drill (modules/zone-drill): one zone down for ten minutes with a safety stop, every target named
# by ARN or by its own cluster tag. Planned against mocked AWS only; running it is a manual, approved step.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/mock" } }
  mock_resource "aws_cloudwatch_metric_alarm" { defaults = { arn = "arn:aws:cloudwatch:ap-south-1:123456789012:alarm:mock" } }
}

variables {
  name                = "acme-prod-aps1"
  region              = "ap-south-1"
  az                  = "ap-south-1a"
  subnet_ids          = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  cluster_name        = "acme-prod-aps1"
  cache_arn           = "arn:aws:elasticache:ap-south-1:123456789012:replicationgroup:acme-prod-aps1-valkey"
  database_deployment = "rds"
  database_arn        = "arn:aws:rds:ap-south-1:123456789012:db:acme-prod-aps1"
  alb_arn_suffix      = "app/acme-prod-aps1/0123456789abcdef"
}

run "takes_one_zone_down_with_a_safety_stop" {
  command = plan

  module {
    source = "../../modules/zone-drill"
  }

  assert {
    condition     = toset([for a in aws_fis_experiment_template.zone.action : a.action_id]) == toset(["aws:network:disrupt-connectivity", "aws:ec2:stop-instances", "aws:elasticache:replicationgroup-interrupt-az-power", "aws:rds:reboot-db-instances"])
    error_message = "The drill must cut the zone's network, stop its nodes, power off its cache nodes and fail the database over."
  }

  assert {
    condition = one([
      for t in aws_fis_experiment_template.zone.target : t.resource_arns if t.name == "subnets"
    ]) == toset(["arn:aws:ec2:ap-south-1:123456789012:subnet/subnet-0aaaaaaaaaaaaaaaa", "arn:aws:ec2:ap-south-1:123456789012:subnet/subnet-0bbbbbbbbbbbbbbbb"])
    error_message = "Subnets must be named by ARN, so no other stack's network is touched."
  }

  assert {
    condition = one([
      for t in aws_fis_experiment_template.zone.target : toset(one([for f in t.filter : f.values if f.path == "Placement.AvailabilityZone"])) == toset(["ap-south-1a"]) && one(t.resource_tag).key == "kubernetes.io/cluster/acme-prod-aps1"
      if t.name == "nodes"
    ])
    error_message = "Only this cluster's nodes in the drill zone may be stopped."
  }

  assert {
    condition     = one([for t in aws_fis_experiment_template.zone.target : t.parameters.availabilityZoneIdentifier if t.name == "cache"]) == "ap-south-1a"
    error_message = "The cache must lose power in the drill zone only."
  }

  assert {
    condition = one([
      for a in aws_fis_experiment_template.zone.action : one([for p in a.parameter : p.value if p.key == "forceFailover"])
      if a.name == "fail-over-database"
    ]) == "true"
    error_message = "RDS must be rebooted with a forced Multi-AZ failover."
  }

  assert {
    condition = alltrue([
      for a in aws_fis_experiment_template.zone.action : alltrue([for p in a.parameter : p.value == "PT10M" if contains(["duration", "startInstancesAfterDuration"], p.key)])
    ])
    error_message = "The zone stays down for ten minutes, then nodes restart."
  }

  assert {
    condition     = one(aws_fis_experiment_template.zone.stop_condition).source == "aws:cloudwatch:alarm" && aws_cloudwatch_metric_alarm.abort.threshold == 0.01 && aws_cloudwatch_metric_alarm.abort.evaluation_periods == 3
    error_message = "A 5xx share above 1% for three minutes must stop the drill."
  }

  assert {
    condition     = toset(keys(aws_iam_role_policy_attachment.fis)) == toset(["AWSFaultInjectionSimulatorNetworkAccess", "AWSFaultInjectionSimulatorEC2Access", "AWSFaultInjectionSimulatorRDSAccess"])
    error_message = "The FIS role gets the AWS managed network, EC2 and RDS policies."
  }

  assert {
    condition     = one(aws_fis_experiment_template.zone.experiment_options).empty_target_resolution_mode == "skip"
    error_message = "A zone without nodes must not fail the whole drill."
  }
}

run "aurora_fails_over_the_cluster" {
  command = plan

  module {
    source = "../../modules/zone-drill"
  }

  variables {
    database_deployment = "aurora"
    database_arn        = "arn:aws:rds:ap-south-1:123456789012:cluster:acme-prod-aps1"
  }

  assert {
    condition     = one([for a in aws_fis_experiment_template.zone.action : a.action_id if a.name == "fail-over-database"]) == "aws:rds:failover-db-cluster"
    error_message = "Aurora must fail over the cluster."
  }

  assert {
    condition     = one([for t in aws_fis_experiment_template.zone.target : t.resource_type if t.name == "database"]) == "aws:rds:cluster"
    error_message = "The Aurora target is the cluster."
  }
}

run "self_managed_database_is_left_to_the_cluster" {
  command = plan

  module {
    source = "../../modules/zone-drill"
  }

  variables {
    database_deployment = "self-managed"
    database_arn        = null
  }

  assert {
    condition     = length([for a in aws_fis_experiment_template.zone.action : a if a.name == "fail-over-database"]) == 0 && length([for t in aws_fis_experiment_template.zone.target : t if t.name == "database"]) == 0
    error_message = "A database on the cluster fails over with its nodes; there is no RDS action."
  }
}

run "rejects_a_zone_outside_the_stack" {
  command = plan

  module {
    source = "../../modules/zone-drill"
  }

  variables {
    subnet_ids = []
  }

  expect_failures = [var.subnet_ids]
}
