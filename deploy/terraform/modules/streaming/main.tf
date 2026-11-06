variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the cluster (no public access)."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets, one per AZ (2 or 3)."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach the brokers."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key for encryption at rest and broker logs."
  type        = string
}

variable "kafka_version" {
  description = "Apache Kafka version on MSK."
  type        = string
  default     = "3.9.x"
}

variable "broker_instance_type" {
  description = "Broker instance type (Graviton by default)."
  type        = string
  default     = "kafka.m7g.large"
}

variable "brokers_per_az" {
  description = "Brokers in each AZ."
  type        = number
  default     = 1
}

variable "volume_gb" {
  description = "EBS storage per broker."
  type        = number
  default     = 100
}

variable "client_broker" {
  description = "Client-to-broker encryption: TLS (default), TLS_PLAINTEXT (also opens 9092 for clients without TLS) or PLAINTEXT."
  type        = string
  default     = "TLS"

  validation {
    condition     = contains(["TLS", "TLS_PLAINTEXT", "PLAINTEXT"], var.client_broker)
    error_message = "client_broker must be TLS, TLS_PLAINTEXT or PLAINTEXT."
  }
}

variable "log_retention_days" {
  description = "Broker log retention."
  type        = number
  default     = 30
}

locals {
  id      = "${var.name}-kafka"
  brokers = length(var.subnet_ids) * var.brokers_per_az
  rf      = min(3, local.brokers)
}

resource "aws_security_group" "this" {
  name        = local.id
  description = "Kafka brokers from app workloads only"
  vpc_id      = var.vpc_id
  tags        = { Name = local.id }
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  count                        = length(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.allowed_security_group_ids[count.index]
  description                  = "Kafka (9092 plaintext, 9094 TLS) from app workloads"
  ip_protocol                  = "tcp"
  from_port                    = 9092
  to_port                      = 9094
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/msk/${local.id}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# The app publishes to one topic and does not create it; let the brokers do so, durably.
resource "aws_msk_configuration" "this" {
  name           = local.id
  kafka_versions = [var.kafka_version]
  server_properties = join("\n", [
    "auto.create.topics.enable=true",
    "default.replication.factor=${local.rf}",
    "min.insync.replicas=${max(1, local.rf - 1)}",
    "num.partitions=6",
  ])

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_msk_cluster" "this" {
  cluster_name           = local.id
  kafka_version          = var.kafka_version
  number_of_broker_nodes = local.brokers

  broker_node_group_info {
    instance_type   = var.broker_instance_type
    client_subnets  = var.subnet_ids
    security_groups = [aws_security_group.this.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.volume_gb
      }
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.this.arn
    revision = aws_msk_configuration.this.latest_revision
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = var.kms_key_arn

    encryption_in_transit {
      client_broker = var.client_broker
      in_cluster    = true
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.this.name
      }
    }
  }
}

output "bootstrap_brokers" {
  description = "KAFKA_BROKERS for the app: TLS brokers with client_broker = TLS, plaintext brokers otherwise (for clients without TLS)."
  value       = var.client_broker == "TLS" ? aws_msk_cluster.this.bootstrap_brokers_tls : aws_msk_cluster.this.bootstrap_brokers
}

output "bootstrap_brokers_plaintext" {
  description = "Plaintext brokers (only with TLS_PLAINTEXT or PLAINTEXT)."
  value       = aws_msk_cluster.this.bootstrap_brokers
}

output "cluster_arn" {
  description = "MSK cluster ARN."
  value       = aws_msk_cluster.this.arn
}
