terraform {
  required_version = ">= 1.10.0"
}

locals {
  # ap-south-1 -> aps1, ap-southeast-1 -> apse1, us-east-1 -> use1, eu-central-1 -> euc1
  short_region = join("", [
    for part in split("-", var.region) :
    replace(replace(replace(replace(replace(part, "north", "n"), "south", "s"), "east", "e"), "west", "w"), "central", "c")
  ])

  # Region is part of the prefix so the same project/environment can run in a second (DR) region
  # of the same account without colliding on account-global names (IAM roles, S3 buckets).
  prefix = "${var.project_name}-${var.environment}-${local.short_region}"
}
