# Zone-failure drill (AWS FIS), off by default. Steps, cost and pass criteria: docs/runbooks/scale-load-and-zone-drill.md.

locals {
  drill_az = coalesce(var.zone_drill_az, module.network.azs[0])
}

module "zone_drill" {
  source              = "../../modules/zone-drill"
  count               = var.enable_zone_failure_drill ? 1 : 0
  name                = module.naming.prefix
  region              = var.region
  az                  = local.drill_az
  subnet_ids          = flatten([for i, az in module.network.azs : [module.network.public_subnet_ids[i], module.network.private_subnet_ids[i]] if az == local.drill_az])
  cluster_name        = module.eks.cluster_name
  cache_arn           = module.cache.arn
  database_deployment = var.database_deployment
  database_arn        = module.database.arn
  alb_arn_suffix      = module.edge.alb_arn_suffix
}

output "zone_drill" {
  description = "Zone-failure drill: the zone it takes down and the FIS experiment template to start, or null when off."
  value       = var.enable_zone_failure_drill ? { az = local.drill_az, experiment_template_id = module.zone_drill[0].experiment_template_id, abort_alarm = module.zone_drill[0].abort_alarm_name } : null
}
