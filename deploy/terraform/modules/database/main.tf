locals {
  managed = var.deployment != "self-managed"
  rds     = var.deployment == "rds"
  aurora  = var.deployment == "aurora"
  id      = "${var.name}-pg"
  family  = local.aurora ? "aurora-postgresql${var.postgres_major_version}" : "postgres${var.postgres_major_version}"
}

resource "aws_db_subnet_group" "this" {
  count      = local.managed ? 1 : 0
  name       = local.id
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  count       = local.managed ? 1 : 0
  name        = local.id
  description = "PostgreSQL from app workloads only"
  vpc_id      = var.vpc_id
  tags        = { Name = local.id }
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  count                        = local.managed ? length(var.allowed_security_group_ids) : 0
  security_group_id            = aws_security_group.this[0].id
  referenced_security_group_id = var.allowed_security_group_ids[count.index]
  description                  = "PostgreSQL from app workloads"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_cloudwatch_log_group" "this" {
  count             = local.managed ? 1 : 0
  name              = "/aws/rds/${local.aurora ? "cluster" : "instance"}/${local.id}/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# ---------------------------------------------------------------- RDS for PostgreSQL

resource "aws_db_parameter_group" "this" {
  count  = local.rds ? 1 : 0
  name   = "${local.id}-${var.postgres_major_version}"
  family = local.family

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # A major upgrade creates the new family's group before the old one goes away.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  count                               = local.rds ? 1 : 0
  identifier                          = local.id
  engine                              = "postgres"
  engine_version                      = var.postgres_major_version
  instance_class                      = var.instance_class
  allocated_storage                   = var.allocated_storage_gb
  max_allocated_storage               = var.max_allocated_storage_gb
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  db_name                             = var.db_name
  username                            = var.username
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  db_subnet_group_name                = aws_db_subnet_group.this[0].name
  vpc_security_group_ids              = [aws_security_group.this[0].id]
  parameter_group_name                = aws_db_parameter_group.this[0].name
  publicly_accessible                 = false
  multi_az                            = var.multi_az
  backup_retention_period             = var.backup_retention_days
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = "${local.id}-final"
  auto_minor_version_upgrade          = true
  allow_major_version_upgrade         = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  apply_immediately                   = var.apply_immediately

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_db_instance" "replica" {
  count                           = local.rds ? var.read_replicas : 0
  identifier                      = "${local.id}-replica-${count.index + 1}"
  replicate_source_db             = aws_db_instance.this[0].identifier
  instance_class                  = var.instance_class
  storage_encrypted               = true # same-region replicas always use the source's KMS key
  vpc_security_group_ids          = [aws_security_group.this[0].id]
  parameter_group_name            = aws_db_parameter_group.this[0].name
  publicly_accessible             = false
  skip_final_snapshot             = true
  auto_minor_version_upgrade      = true
  deletion_protection             = var.deletion_protection
  enabled_cloudwatch_logs_exports = ["postgresql"]
  apply_immediately               = var.apply_immediately

  depends_on = [aws_cloudwatch_log_group.replica]
}

# Created up front, like the primary's, so replica logs get the same retention and KMS key.
resource "aws_cloudwatch_log_group" "replica" {
  count             = local.rds ? var.read_replicas : 0
  name              = "/aws/rds/instance/${local.id}-replica-${count.index + 1}/postgresql"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# ---------------------------------------------------------------- Aurora PostgreSQL

# Aurora wants a full engine version: take the newest minor of the requested major. This also fails
# at plan time, with a clear error, while AWS does not offer that major yet.
data "aws_rds_engine_version" "aurora" {
  count   = local.aurora ? 1 : 0
  engine  = "aurora-postgresql"
  version = var.postgres_major_version
  latest  = true
}

resource "aws_rds_cluster_parameter_group" "this" {
  count  = local.aurora ? 1 : 0
  name   = "${local.id}-${var.postgres_major_version}"
  family = local.family

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_rds_cluster" "this" {
  count                               = local.aurora ? 1 : 0
  cluster_identifier                  = local.id
  engine                              = "aurora-postgresql"
  engine_version                      = data.aws_rds_engine_version.aurora[0].version_actual
  database_name                       = var.db_name
  master_username                     = var.username
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  db_subnet_group_name                = aws_db_subnet_group.this[0].name
  vpc_security_group_ids              = [aws_security_group.this[0].id]
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.this[0].name
  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  backup_retention_period             = var.backup_retention_days
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = "${local.id}-final"
  allow_major_version_upgrade         = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  apply_immediately                   = var.apply_immediately

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_rds_cluster_instance" "this" {
  count                      = local.aurora ? 1 + var.read_replicas : 0
  identifier                 = "${local.id}-${count.index + 1}"
  cluster_identifier         = aws_rds_cluster.this[0].id
  instance_class             = var.instance_class
  engine                     = aws_rds_cluster.this[0].engine
  engine_version             = aws_rds_cluster.this[0].engine_version
  publicly_accessible        = false
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately
}
