variable "name" {
  description = "Cluster name (the naming module's prefix)."
  type        = string
}

variable "region" {
  description = "AWS region of the cluster."
  type        = string
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version (null: the EKS default at creation). Pin it in production."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Private subnets for the control plane ENIs and nodes."
  type        = list(string)
}

variable "admin_cidrs" {
  description = "CIDRs allowed to reach the public API endpoint. Empty: private endpoint only."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key for Kubernetes secrets envelope encryption and control-plane logs."
  type        = string
}

variable "deletion_protection" {
  description = "EKS cluster deletion protection (on in prod)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retention of the control-plane log group."
  type        = number
  default     = 30
}

variable "node_instance_types" {
  description = "Managed node group instance types (Graviton by default)."
  type        = list(string)
  default     = ["t4g.large"]
}

variable "node_ami_type" {
  description = "EKS AMI type; must match the instance architecture."
  type        = string
  default     = "AL2023_ARM_64_STANDARD"
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT."
  type        = string
  default     = "ON_DEMAND"
}

variable "node_min" {
  description = "Minimum nodes."
  type        = number
  default     = 2
}

variable "node_desired" {
  description = "Initial desired nodes (later owned by the autoscaler)."
  type        = number
  default     = 2
}

variable "node_max" {
  description = "Maximum nodes."
  type        = number
  default     = 4
}

variable "node_disk_gb" {
  description = "Node root volume size."
  type        = number
  default     = 50
}

variable "node_metadata_hop_limit" {
  description = "IMDS hop limit on nodes. 2 lets non-hostNetwork add-ons discover their region; 1 hides node credentials from pods."
  type        = number
  default     = 2
}

variable "admin_role_arns" {
  description = "IAM roles granted cluster-admin through EKS access entries (the creator is admin already)."
  type        = list(string)
  default     = []
}

variable "namespace_deployers" {
  description = "Roles allowed to deploy into app_namespace only (e.g. { ci = <CI role ARN> })."
  type        = map(string)
  default     = {}
}

variable "app_namespace" {
  description = "Namespace the app's Helm release runs in."
  type        = string
  default     = "agentbazaar"
}

variable "alb_security_group_id" {
  description = "ALB security group, allowed to reach pod ports (IP target groups)."
  type        = string
}

variable "app_ports" {
  description = "Pod ports the ALB forwards to."
  type        = list(number)
  default     = [3000, 4000]
}

variable "target_group_arns" {
  description = "Target groups the AWS Load Balancer Controller may register pods into."
  type        = list(string)
}

variable "enable_karpenter" {
  description = "Create Karpenter's IAM roles, interruption queue and discovery tags (install the Karpenter chart yourself)."
  type        = bool
  default     = false
}
