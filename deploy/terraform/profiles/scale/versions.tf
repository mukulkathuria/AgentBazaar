terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = module.naming.tags
  }
}

# AWS requires CloudFront certificates to be issued in us-east-1, whatever region the stack uses.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = module.naming.tags
  }
}

# Disaster-recovery region for AWS Backup copies (backup.tf).
provider "aws" {
  alias  = "backup_copy"
  region = var.backup_copy_region

  default_tags {
    tags = module.naming.tags
  }
}
