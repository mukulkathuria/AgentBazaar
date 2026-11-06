variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "region" {
  description = "Region of the stack (builds the subnet ARNs)."
  type        = string
}

variable "az" {
  description = "Availability zone the drill takes down, e.g. ap-south-1a."
  type        = string
}

variable "subnet_ids" {
  description = "This stack's subnets in that zone (public and private); they lose all connectivity."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) > 0
    error_message = "No subnets in the drill zone: the zone must be one of the stack's availability zones."
  }
}

variable "cluster_name" {
  description = "EKS cluster whose nodes in the zone are stopped (tag kubernetes.io/cluster/<name> = owned)."
  type        = string
}

variable "cache_arn" {
  description = "ElastiCache replication group whose nodes in the zone lose power (needs Multi-AZ, i.e. replicas > 0)."
  type        = string
}

variable "database_deployment" {
  description = "rds (reboot with forced failover), aurora (cluster failover) or self-managed (no database action)."
  type        = string

  validation {
    condition     = contains(["rds", "aurora", "self-managed"], var.database_deployment)
    error_message = "database_deployment must be rds, aurora or self-managed."
  }
}

variable "database_arn" {
  description = "DB instance (rds) or cluster (aurora) ARN; null for self-managed."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix: the drill stops itself when more than 1% of the ALB's requests fail with 5xx for three minutes."
  type        = string
}
