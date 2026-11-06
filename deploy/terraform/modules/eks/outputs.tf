output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_arn" {
  description = "EKS cluster ARN."
  value       = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_security_group_id" {
  description = "Cluster security group (attached to managed nodes, hence to pods)."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "kubeconfig_command" {
  description = "Command that writes a kubeconfig entry for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.this.name}"
}

output "lb_controller_role_arn" {
  description = "Pod Identity role of the AWS Load Balancer Controller (kube-system/aws-load-balancer-controller)."
  value       = aws_iam_role.pod["lb-controller"].arn
}

output "karpenter" {
  description = "Values for the Karpenter Helm chart, or null when disabled."
  value = var.enable_karpenter ? {
    interruption_queue = aws_sqs_queue.karpenter[0].name
    node_role_name     = aws_iam_role.karpenter_node[0].name
    discovery_tag      = { "karpenter.sh/discovery" = var.name }
  } : null
}
