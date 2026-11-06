variable "name" {
  description = "Name prefix from the naming module."
  type        = string
}

variable "domain_name" {
  description = "Storefront domain, e.g. shop.example.com. The API is served on api.<domain>, media on media.<domain>."
  type        = string
}

variable "zone_name" {
  description = "Public Route 53 hosted zone holding domain_name (null: domain_name itself)."
  type        = string
  default     = null
}

variable "host_ip" {
  description = "Public IP the storefront and API records point at when there is no load balancer (lite)."
  type        = string
  default     = null
}

variable "enable_alb" {
  description = "Create the internet-facing ALB (growth/scale). False points DNS at host_ip."
  type        = bool
  default     = false
}

variable "vpc_id" {
  description = "VPC of the ALB target groups."
  type        = string
  default     = null
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
  default     = []
}

variable "alb_security_group_id" {
  description = "Security group of the ALB (80/443 from the internet)."
  type        = string
  default     = null
}

variable "app_ports" {
  description = "Container ports of the web and api target groups."
  type        = object({ web = number, api = number })
  default     = { web = 3000, api = 4000 }
}

variable "health_check_paths" {
  description = "Liveness path per target group: the storefront's /api/health and the API's /healthz."
  type        = object({ web = string, api = string })
  default     = { web = "/api/health", api = "/healthz" }
}

variable "deletion_protection" {
  description = "ALB deletion protection (on in prod)."
  type        = bool
  default     = false
}

variable "enable_waf" {
  description = "Attach an AWS WAF web ACL with AWS managed rule groups to the ALB."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "Requests per 5 minutes per client IP before WAF blocks (0 disables the rate rule)."
  type        = number
  default     = 2000
}

variable "waf_count_only_rules" {
  description = "Core rule set rules switched to count mode. SizeRestrictions_BODY would block the API's legitimate bodies over 8 KB."
  type        = list(string)
  default     = ["SizeRestrictions_BODY"]
}

variable "enable_shield_advanced" {
  description = "Add Shield Advanced protections. Requires an active Shield Advanced subscription (a paid annual commitment you start yourself)."
  type        = bool
  default     = false
}

variable "enable_cdn" {
  description = "Serve the media bucket through CloudFront at media.<domain>."
  type        = bool
  default     = false
}

variable "media_bucket_regional_domain_name" {
  description = "Regional domain name of the media bucket (CloudFront origin)."
  type        = string
  default     = null
}

variable "cdn_price_class" {
  description = "CloudFront price class. PriceClass_200 includes edge locations in India."
  type        = string
  default     = "PriceClass_200"
}
