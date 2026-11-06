variable "project_name" {
  description = "Short slug that prefixes every resource name."
  type        = string

  validation {
    condition     = length(var.project_name) <= 20 && can(regex("^[a-z](-?[a-z0-9])+$", var.project_name))
    error_message = "project_name must be 2-20 characters: lowercase letters, digits and single hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "environment" {
  description = "Environment name, e.g. staging or prod. \"prod\" turns on deletion protection everywhere."
  type        = string

  validation {
    condition     = length(var.environment) <= 10 && can(regex("^[a-z](-?[a-z0-9])+$", var.environment))
    error_message = "environment must be 2-10 characters: lowercase letters, digits and single hyphens, starting with a letter."
  }
}

variable "region" {
  description = "AWS region code, e.g. ap-south-1."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region code such as ap-south-1."
  }
}

variable "profile" {
  description = "Deployment profile: lite, growth or scale."
  type        = string

  validation {
    condition     = contains(["lite", "growth", "scale"], var.profile)
    error_message = "profile must be one of lite, growth, scale."
  }
}
