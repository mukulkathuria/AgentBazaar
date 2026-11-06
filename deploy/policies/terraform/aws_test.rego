# conftest verify --policy deploy/policies/terraform
package main

import rego.v1

change(address, type, after) := {"address": address, "mode": "managed", "type": type, "change": {"actions": ["create"], "after": after, "after_unknown": {}}}

in_module(module, r) := object.union(r, {"module_address": module, "address": sprintf("%s.%s", [module, r.address])})

compliant := [
	change("aws_db_instance.this", "aws_db_instance", {"publicly_accessible": false, "storage_encrypted": true}),
	change("aws_rds_cluster.this", "aws_rds_cluster", {"storage_encrypted": true}),
	change("aws_rds_cluster_instance.this", "aws_rds_cluster_instance", {"publicly_accessible": false}),
	change("aws_elasticache_replication_group.this", "aws_elasticache_replication_group", {"at_rest_encryption_enabled": "true"}),
	change("aws_opensearch_domain.this", "aws_opensearch_domain", {"encrypt_at_rest": [{"enabled": true}], "vpc_options": [{"subnet_ids": ["subnet-1"]}]}),
	change("aws_ebs_volume.data", "aws_ebs_volume", {"encrypted": true}),
	change("aws_instance.app", "aws_instance", {"root_block_device": [{"encrypted": true}]}),
	change("aws_launch_template.nodes", "aws_launch_template", {"block_device_mappings": [{"ebs": [{"encrypted": "true"}]}]}),
	change("aws_sqs_queue.events", "aws_sqs_queue", {"sqs_managed_sse_enabled": true}),
	change("aws_sns_topic.alarms", "aws_sns_topic", {"kms_master_key_id": "arn:aws:kms:ap-south-1:123456789012:key/k"}),
	in_module("module.storage", change("aws_s3_bucket.this", "aws_s3_bucket", {})),
	in_module("module.storage", change("aws_s3_bucket_server_side_encryption_configuration.this", "aws_s3_bucket_server_side_encryption_configuration", {})),
	in_module("module.storage", change("aws_s3_bucket_public_access_block.this", "aws_s3_bucket_public_access_block", {
		"block_public_acls": true, "block_public_policy": true, "ignore_public_acls": true, "restrict_public_buckets": true,
	})),
	change("aws_iam_role_policy_attachment.ssm", "aws_iam_role_policy_attachment", {"policy_arn": "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"}),
]

policy_doc(name, statements) := {"address": sprintf("data.aws_iam_policy_document.%s", [name]), "mode": "data", "type": "aws_iam_policy_document", "values": {"statement": statements}}

documents := [
	policy_doc("discover", [{"sid": "Discover", "effect": null, "actions": ["ec2:DescribeInstances", "pricing:GetProducts"], "resources": ["*"]}]),
	policy_doc("launch", [{"sid": "Launch", "actions": ["ec2:RunInstances"], "resources": ["*"], "condition": [{"test": "StringEquals", "variable": "aws:RequestedRegion", "values": ["ap-south-1"]}]}]),
	policy_doc("key", [{"sid": "Admin", "actions": ["kms:Decrypt"], "resources": ["*"], "principals": [{"type": "AWS", "identifiers": ["arn:aws:iam::123456789012:root"]}]}]),
	policy_doc("tls", [{"sid": "DenyInsecureTransport", "effect": "Deny", "actions": ["s3:*"], "resources": ["arn:aws:s3:::b/*"], "principals": [{"type": "*", "identifiers": ["*"]}]}]),
]

plan(changes, docs) := {
	"resource_changes": changes,
	"prior_state": {"values": {"root_module": {"child_modules": [{"address": "module.eks", "resources": docs}]}}},
	"planned_values": {"outputs": {"tags": {"value": {"Project": "agentbazaar", "Environment": "staging", "Profile": "growth", "ManagedBy": "terraform"}}}},
	"configuration": {"provider_config": {
		"aws": {"name": "aws", "expressions": {"default_tags": [{"tags": {"references": ["module.naming.tags"]}}]}},
		"aws.us_east_1": {"name": "aws", "alias": "us_east_1", "expressions": {"default_tags": [{"tags": {"references": ["module.naming.tags"]}}]}},
	}},
}

denials(p) := result if {
	result := deny with input as p
}

denied(p, fragment) if {
	some msg in denials(p)
	contains(msg, fragment)
}

patched(r, address, after) := object.union(r, {"change": object.union(r.change, {"after": object.union(r.change.after, after)})}) if {
	endswith(r.address, address)
}

patched(r, address, _) := r if not endswith(r.address, address)

# The compliant plan with one resource's attributes overridden.
with_after(address, after) := [patched(r, address, after) | some r in compliant]

test_compliant_plan_passes if {
	count(denials(plan(compliant, documents))) == 0
}

test_public_databases_are_denied if {
	denied(plan(with_after("aws_db_instance.this", {"publicly_accessible": true}), documents), "must not be publicly accessible")
	denied(plan(with_after("aws_rds_cluster_instance.this", {"publicly_accessible": true}), documents), "must not be publicly accessible")
	denied(plan(with_after("aws_opensearch_domain.this", {"vpc_options": []}), documents), "inside the VPC")
}

test_unencrypted_storage_is_denied if {
	denied(plan(with_after("aws_db_instance.this", {"storage_encrypted": false}), documents), "aws_db_instance.this: storage must be encrypted")
	denied(plan(with_after("aws_rds_cluster.this", {"storage_encrypted": false}), documents), "aws_rds_cluster.this: storage must be encrypted")
	denied(plan(with_after("aws_elasticache_replication_group.this", {"at_rest_encryption_enabled": "false"}), documents), "storage must be encrypted")
	denied(plan(with_after("aws_opensearch_domain.this", {"encrypt_at_rest": [{"enabled": false}]}), documents), "encrypt_at_rest.0.enabled")
	denied(plan(with_after("aws_ebs_volume.data", {"encrypted": false}), documents), "aws_ebs_volume.data: storage must be encrypted")
	denied(plan(with_after("aws_instance.app", {"root_block_device": []}), documents), "aws_instance.app: storage must be encrypted")
	denied(plan(with_after("aws_launch_template.nodes", {"block_device_mappings": [{"ebs": [{"encrypted": "false"}]}]}), documents), "launch template volumes")
	denied(plan(with_after("aws_sqs_queue.events", {"sqs_managed_sse_enabled": false}), documents), "SQS queues")
	denied(plan(with_after("aws_sns_topic.alarms", {"kms_master_key_id": ""}), documents), "SNS topics")
}

test_buckets_need_encryption_and_a_public_access_block if {
	extra := in_module("module.storage", change("aws_s3_bucket.logs", "aws_s3_bucket", {}))
	denied(plan(array.concat(compliant, [extra]), documents), "every aws_s3_bucket needs an aws_s3_bucket_server_side_encryption_configuration")
	denied(plan(array.concat(compliant, [extra]), documents), "every aws_s3_bucket needs an aws_s3_bucket_public_access_block")
	denied(plan(with_after("aws_s3_bucket_public_access_block.this", {"restrict_public_buckets": false}), documents), "restrict_public_buckets must be true")
	acl := change("aws_s3_bucket_acl.this", "aws_s3_bucket_acl", {"acl": "public-read"})
	denied(plan(array.concat(compliant, [acl]), documents), "public ACL")
}

test_required_tags if {
	untagged := json.patch(plan(compliant, documents), [{"op": "remove", "path": "/configuration/provider_config/aws.us_east_1/expressions/default_tags"}])
	denied(untagged, "provider aws.us_east_1: default_tags must be set")
	no_profile := json.patch(plan(compliant, documents), [{"op": "remove", "path": "/planned_values/outputs/tags/value/Profile"}])
	denied(no_profile, "missing {\"Profile\"}")
}

test_wildcard_iam_is_denied if {
	everything := policy_doc("admin", [{"sid": "All", "actions": ["*"], "resources": ["arn:aws:s3:::b"]}])
	denied(plan(compliant, array.concat(documents, [everything])), "wildcard action \"*\"")
	service := policy_doc("s3", [{"sid": "S3", "effect": "Allow", "actions": ["s3:*"], "resources": ["arn:aws:s3:::b"]}])
	denied(plan(compliant, array.concat(documents, [service])), "wildcard action \"s3:*\"")
	inverted := policy_doc("inv", [{"sid": "Inv", "not_actions": ["iam:*"], "resources": ["arn:aws:s3:::b"]}])
	denied(plan(compliant, array.concat(documents, [inverted])), "inverted wildcard")
	any_resource := policy_doc("put", [{"sid": "Put", "actions": ["s3:PutObject"], "resources": ["*"]}])
	denied(plan(compliant, array.concat(documents, [any_resource])), "must not allow \"s3:PutObject\" on every resource")
	admin := change("aws_iam_role_policy_attachment.admin", "aws_iam_role_policy_attachment", {"policy_arn": "arn:aws:iam::aws:policy/AdministratorAccess"})
	denied(plan(array.concat(compliant, [admin]), documents), "AdministratorAccess")
}

test_inline_json_policies_are_checked if {
	inline := change("aws_iam_role_policy.inline", "aws_iam_role_policy", {"policy": json.marshal({"Version": "2012-10-17", "Statement": {"Effect": "Allow", "Action": "*", "Resource": "*"}})})
	denied(plan(array.concat(compliant, [inline]), documents), "aws_iam_role_policy.inline: IAM must not allow the wildcard action \"*\"")
	trust := change("aws_iam_role.app", "aws_iam_role", {"assume_role_policy": json.marshal({"Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole", "Principal": {"Service": "ec2.amazonaws.com"}}]})})
	count(denials(plan(array.concat(compliant, [trust]), documents))) == 0
}
