output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "azs" {
  description = "Availability zones in use."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public subnet IDs, one per AZ."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs, one per AZ."
  value       = aws_subnet.private[*].id
}

output "web_security_group_id" {
  description = "Security group allowing 80/443 from the internet."
  value       = aws_security_group.web.id
}

output "ssh_security_group_id" {
  description = "Security group allowing 22 from admin_cidrs, or null."
  value       = one(aws_security_group.ssh[*].id)
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs (empty in lite)."
  value       = aws_nat_gateway.this[*].id
}
