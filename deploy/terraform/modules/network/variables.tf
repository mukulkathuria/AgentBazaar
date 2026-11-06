variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "cidr" {
  description = "VPC CIDR. A /16 leaves room for /18 private subnets (EKS pod IPs)."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr, 0))
    error_message = "cidr must be a valid IPv4 CIDR block."
  }
}

variable "az_count" {
  description = "Number of availability zones (2 or 3)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "nat_gateway_mode" {
  description = "none (lite: no private egress, no NAT cost), single (one shared NAT) or per_az (one NAT per AZ)."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "single", "per_az"], var.nat_gateway_mode)
    error_message = "nat_gateway_mode must be none, single or per_az."
  }
}

variable "admin_cidrs" {
  description = "CIDRs allowed to SSH (port 22) when allow_ssh is true."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.admin_cidrs : can(cidrhost(c, 0))])
    error_message = "Every admin_cidrs entry must be a valid CIDR block."
  }
}

variable "allow_ssh" {
  description = "Create an SSH security group open to admin_cidrs only."
  type        = bool
  default     = false
}

variable "web_sg_internet_egress" {
  description = "Let the web security group reach the internet (lite host). False limits egress to the VPC (ALB)."
  type        = bool
  default     = false
}

variable "public_subnet_tags" {
  description = "Extra tags for public subnets."
  type        = map(string)
  default     = {}
}

variable "private_subnet_tags" {
  description = "Extra tags for private subnets (e.g. karpenter.sh/discovery)."
  type        = map(string)
  default     = {}
}
