output "instance_id" {
  description = "Host instance ID."
  value       = aws_instance.this.id
}

output "instance_arn" {
  description = "Host instance ARN (CI sends upgrade commands to it through SSM)."
  value       = aws_instance.this.arn
}

output "public_ip" {
  description = "Elastic IP of the host."
  value       = aws_eip.this.public_ip
}

output "role_name" {
  description = "IAM role of the host."
  value       = aws_iam_role.this.name
}

output "data_volume_id" {
  description = "EBS data volume holding Docker's data-root."
  value       = aws_ebs_volume.data.id
}
