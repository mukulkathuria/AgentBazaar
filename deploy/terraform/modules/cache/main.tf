variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the cache."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect on 6379."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key for encryption at rest."
  type        = string
}

variable "engine_version" {
  description = "Valkey engine version."
  type        = string
  default     = "8.1"
}

variable "node_type" {
  description = "Node type (Graviton by default)."
  type        = string
  default     = "cache.t4g.small"
}

variable "cluster_mode" {
  description = "Shard keys across node groups. Clients must be cluster-aware."
  type        = bool
  default     = false
}

variable "shards" {
  description = "Node groups when cluster_mode is true."
  type        = number
  default     = 2
}

variable "replicas" {
  description = "Replicas per shard (or per primary without cluster mode). Above 0 enables Multi-AZ failover."
  type        = number
  default     = 0
}

variable "snapshot_retention_days" {
  description = "Daily snapshot retention (0 disables snapshots)."
  type        = number
  default     = 1
}

variable "apply_immediately" {
  description = "Apply modifications now instead of in the maintenance window."
  type        = bool
  default     = false
}

locals {
  id    = trimsuffix(substr("${var.name}-valkey", 0, 40), "-")
  major = split(".", var.engine_version)[0]
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.id
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = local.id
  description = "Valkey from app workloads only"
  vpc_id      = var.vpc_id
  tags        = { Name = local.id }
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  count                        = length(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.allowed_security_group_ids[count.index]
  description                  = "Valkey from app workloads"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = local.id
  description                = "${var.name} cache"
  engine                     = "valkey"
  engine_version             = var.engine_version
  node_type                  = var.node_type
  port                       = 6379
  parameter_group_name       = "default.valkey${local.major}${var.cluster_mode ? ".cluster.on" : ""}"
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.this.id]
  cluster_mode               = var.cluster_mode ? "enabled" : "disabled"
  num_node_groups            = var.cluster_mode ? var.shards : null
  replicas_per_node_group    = var.cluster_mode ? var.replicas : null
  num_cache_clusters         = var.cluster_mode ? null : 1 + var.replicas
  automatic_failover_enabled = var.cluster_mode || var.replicas > 0
  multi_az_enabled           = var.replicas > 0
  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  snapshot_retention_limit   = var.snapshot_retention_days
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately
}

locals {
  endpoint = var.cluster_mode ? aws_elasticache_replication_group.this.configuration_endpoint_address : aws_elasticache_replication_group.this.primary_endpoint_address
}

output "endpoint" {
  description = "Primary (or cluster configuration) endpoint."
  value       = local.endpoint
}

output "url" {
  description = "VALKEY_URL for the app (rediss:// = TLS)."
  value       = "rediss://${local.endpoint}:6379"
}

output "security_group_id" {
  description = "Cache security group."
  value       = aws_security_group.this.id
}

output "arn" {
  description = "Replication group ARN (zone-failure drill target)."
  value       = aws_elasticache_replication_group.this.arn
}
