data "aws_availability_zones" "available" {
  state = "available"

  # Regular AZs only; Local/Wavelength Zones need an opt-in and lack most managed services.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs       = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  nat_count = { none = 0, single = 1, per_az = var.az_count }[var.nat_gateway_mode]
  ssh       = var.allow_ssh && length(var.admin_cidrs) > 0
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# Removes every rule from the default security group so nothing can rely on it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

# Public /22s come from the first /18 of the VPC; private subnets take the other three /18s.
resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 6, count.index)
  map_public_ip_on_launch = false # the lite host gets an Elastic IP; load balancers and NATs bring their own
  tags = merge(
    { Name = "${var.name}-public-${local.azs[count.index]}", "kubernetes.io/role/elb" = "1" },
    var.public_subnet_tags,
  )
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 2, count.index + 1)
  tags = merge(
    { Name = "${var.name}-private-${local.azs[count.index]}", "kubernetes.io/role/internal-elb" = "1" },
    var.private_subnet_tags,
  )
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${var.name}-nat-${count.index}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

# Without a NAT (lite) private subnets have no internet route at all; only data stores live there.
resource "aws_route" "private_nat" {
  count                  = local.nat_count > 0 ? var.az_count : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[min(count.index, local.nat_count - 1)].id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "HTTP and HTTPS from the internet"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.web.id
  description       = "Public web traffic"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
}

resource "aws_vpc_security_group_egress_rule" "web" {
  security_group_id = aws_security_group.web.id
  description       = var.web_sg_internet_egress ? "Host downloads packages, images and code" : "Load balancer to targets inside the VPC"
  cidr_ipv4         = var.web_sg_internet_egress ? "0.0.0.0/0" : var.cidr
  ip_protocol       = "-1"
}

resource "aws_security_group" "ssh" {
  count       = local.ssh ? 1 : 0
  name        = "${var.name}-ssh"
  description = "SSH from admin CIDRs only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-ssh" }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = local.ssh ? toset(var.admin_cidrs) : toset([])
  security_group_id = aws_security_group.ssh[0].id
  description       = "SSH from an admin CIDR"
  cidr_ipv4         = each.key
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}
