# Rules for OpenTofu/Terraform plan JSON (`tofu show -json`, or the `test_plan` messages of
# `tofu test -json -verbose`, which plan against mocked providers; see .github/workflows/iac.yml):
#   conftest test --policy deploy/policies/terraform plan.json
package main

import rego.v1

managed contains r if {
	some r in input.resource_changes
	r.mode == "managed"
	not r.change.actions == ["delete"]
}

after(r, path) := object.get(r.change.after, path, null)

truthy(v) if v == true

truthy(v) if v == "true"

# --- No public database -------------------------------------------------------------------------

deny contains msg if {
	some r in managed
	r.type in {"aws_db_instance", "aws_rds_cluster_instance"}
	truthy(after(r, "publicly_accessible"))
	msg := sprintf("%s: databases must not be publicly accessible", [r.address])
}

deny contains msg if {
	some r in managed
	r.type == "aws_opensearch_domain"
	count(object.get(r.change.after, "vpc_options", [])) == 0
	msg := sprintf("%s: OpenSearch must run inside the VPC (vpc_options), never on a public endpoint", [r.address])
}

deny contains msg if {
	some r in managed
	r.type == "aws_msk_cluster"
	access := after(r, ["broker_node_group_info", 0, "connectivity_info", 0, "public_access", 0, "type"])
	access != null
	access != "DISABLED"
	msg := sprintf("%s: Kafka brokers must not be publicly accessible", [r.address])
}

# --- Encryption at rest --------------------------------------------------------------------------

encryption_flags := {
	"aws_db_instance": ["storage_encrypted"],
	"aws_rds_cluster": ["storage_encrypted"],
	"aws_ebs_volume": ["encrypted"],
	"aws_elasticache_replication_group": ["at_rest_encryption_enabled"],
	"aws_opensearch_domain": ["encrypt_at_rest", 0, "enabled"],
	"aws_instance": ["root_block_device", 0, "encrypted"],
}

deny contains msg if {
	some r in managed
	path := encryption_flags[r.type]
	not truthy(after(r, path))
	msg := sprintf("%s: storage must be encrypted at rest (%s)", [r.address, concat(".", [sprintf("%v", [p]) | some p in path])])
}

deny contains msg if {
	some r in managed
	r.type == "aws_launch_template"
	some mapping in object.get(r.change.after, "block_device_mappings", [])
	some ebs in object.get(mapping, "ebs", [])
	not truthy(object.get(ebs, "encrypted", null))
	msg := sprintf("%s: launch template volumes must be encrypted", [r.address])
}

deny contains msg if {
	some r in managed
	r.type == "aws_sqs_queue"
	not truthy(after(r, "sqs_managed_sse_enabled"))
	object.get(r.change.after, "kms_master_key_id", "") == ""
	msg := sprintf("%s: SQS queues must use server-side encryption", [r.address])
}

deny contains msg if {
	some r in managed
	r.type == "aws_sns_topic"
	object.get(r.change.after, "kms_master_key_id", "") == ""
	not r.change.after_unknown.kms_master_key_id
	msg := sprintf("%s: SNS topics must be encrypted with a KMS key", [r.address])
}

module_of(r) := object.get(r, "module_address", "")

# Each module that creates S3 buckets must also configure encryption and block public access for them.
deny contains msg if {
	some module in {module_of(r) | some r in managed; r.type == "aws_s3_bucket"}
	buckets := count([r | some r in managed; module_of(r) == module; r.type == "aws_s3_bucket"])
	some companion in ["aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block"]
	count([r | some r in managed; module_of(r) == module; r.type == companion]) < buckets
	msg := sprintf("%s: every aws_s3_bucket needs an %s", [module, companion])
}

# --- S3 public access blocked ------------------------------------------------------------------

deny contains msg if {
	some r in managed
	r.type == "aws_s3_bucket_public_access_block"
	some flag in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]
	not truthy(after(r, flag))
	msg := sprintf("%s: %s must be true", [r.address, flag])
}

deny contains msg if {
	some r in managed
	r.type == "aws_s3_bucket_acl"
	after(r, "acl") in {"public-read", "public-read-write", "authenticated-read"}
	msg := sprintf("%s: buckets must not have a public ACL", [r.address])
}

# --- Required tags ------------------------------------------------------------------------------

required_tags := {"Project", "Environment", "Profile", "ManagedBy"}

# Every resource is tagged through the provider's default_tags, so every AWS provider must set them...
deny contains msg if {
	some name, provider in input.configuration.provider_config
	provider.name == "aws"
	not provider.expressions.default_tags
	msg := sprintf("provider %s: default_tags must be set so every resource carries %v", [name, required_tags])
}

# ...to a map holding the required keys (each profile exposes it as the `tags` output).
deny contains msg if {
	tags := object.get(input, ["planned_values", "outputs", "tags", "value"], {})
	missing := {t | some t in required_tags; not tags[t]}
	count(missing) > 0
	msg := sprintf("the default tags are missing %v", [missing])
}

# --- No wildcard IAM ----------------------------------------------------------------------------

as_list(x) := x if is_array(x)

as_list(x) := [x] if is_string(x)

as_list(x) := [x] if is_object(x)

as_list(x) := [] if x == null

# aws_iam_policy_document data sources (read at plan time, so they sit in prior_state or planned_values).
statements contains {"where": sprintf("%s (%s)", [doc.address, object.get(s, "sid", "")]), "s": normalized} if {
	walk(input, [path, doc])
	path[0] in {"prior_state", "planned_values"}
	is_object(doc)
	doc.mode == "data"
	doc.type == "aws_iam_policy_document"
	some s in object.get(doc.values, "statement", [])
	normalized := {
		"effect": object.get(s, "effect", "Allow"),
		"actions": as_list(object.get(s, "actions", [])),
		"not_actions": as_list(object.get(s, "not_actions", [])),
		"resources": as_list(object.get(s, "resources", [])),
		"not_resources": as_list(object.get(s, "not_resources", [])),
		"principals": count(as_list(object.get(s, "principals", []))) > 0,
		"conditions": count(as_list(object.get(s, "condition", []))) > 0,
	}
}

# Inline JSON policies on resources (jsonencode), when known at plan time.
statements contains {"where": r.address, "s": normalized} if {
	some r in managed
	some attr in ["policy", "assume_role_policy"]
	text := after(r, attr)
	is_string(text)
	json.is_valid(text)
	some s in as_list(object.get(json.unmarshal(text), "Statement", []))
	normalized := {
		"effect": object.get(s, "Effect", "Allow"),
		"actions": as_list(object.get(s, "Action", [])),
		"not_actions": as_list(object.get(s, "NotAction", [])),
		"resources": as_list(object.get(s, "Resource", [])),
		"not_resources": as_list(object.get(s, "NotResource", [])),
		"principals": object.get(s, "Principal", null) != null,
		"conditions": object.get(s, "Condition", null) != null,
	}
}

allows contains st if {
	some st in statements
	object.get(st.s, "effect", "Allow") in {"Allow", null}
}

# "*" or "service:*"; prefixes such as "ec2:Describe*" stay allowed.
wildcard_action(a) if a == "*"

wildcard_action(a) if endswith(a, ":*")

read_only(a) if regex.match(`^[a-z0-9-]+:(Describe|List|Get)[A-Za-z0-9]*\*?$`, a)

deny contains msg if {
	some st in allows
	some a in st.s.actions
	wildcard_action(a)
	msg := sprintf("%s: IAM must not allow the wildcard action %q", [st.where, a])
}

deny contains msg if {
	some st in allows
	some key in ["not_actions", "not_resources"]
	count(st.s[key]) > 0
	msg := sprintf("%s: IAM must not allow with %s (an inverted wildcard)", [st.where, key])
}

# Identity policies (no principals) may use Resource "*" only for read-only discovery or under a condition.
# Resource policies (KMS key, bucket, queue and trust policies) name principals, and there "*" is the resource itself.
deny contains msg if {
	some st in allows
	not st.s.principals
	"*" in st.s.resources
	not st.s.conditions
	some a in st.s.actions
	not read_only(a)
	msg := sprintf("%s: IAM must not allow %q on every resource without a condition", [st.where, a])
}

deny contains msg if {
	some r in managed
	r.type in {"aws_iam_role_policy_attachment", "aws_iam_user_policy_attachment", "aws_iam_group_policy_attachment"}
	arn := after(r, "policy_arn")
	is_string(arn)
	some admin in ["AdministratorAccess", "PowerUserAccess", "IAMFullAccess"]
	endswith(arn, sprintf(":policy/%s", [admin]))
	msg := sprintf("%s: IAM must not attach the wildcard managed policy %s", [r.address, admin])
}
