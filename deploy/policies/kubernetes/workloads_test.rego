# conftest verify --policy deploy/policies/kubernetes
package main

import rego.v1

pod_labels := {"app.kubernetes.io/name": "agentbazaar", "app.kubernetes.io/instance": "t", "app.kubernetes.io/component": "api"}

good_container := {
	"name": "api",
	"image": "ghcr.io/acme/agentbazaar-api:0.9.0",
	"ports": [{"name": "http", "containerPort": 4000}],
	"readinessProbe": {"httpGet": {"path": "/readyz", "port": "http"}},
	"livenessProbe": {"httpGet": {"path": "/healthz", "port": "http"}},
	"resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "1", "memory": "512Mi"}},
	"securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": {"drop": ["ALL"]}},
}

pod_spec(containers) := {"securityContext": {"runAsNonRoot": true, "runAsUser": 1000}, "containers": containers}

deployment(container) := {
	"apiVersion": "apps/v1",
	"kind": "Deployment",
	"metadata": {"name": "api"},
	"spec": {"template": {"metadata": {"labels": pod_labels}, "spec": pod_spec([container])}},
}

default_deny := {
	"apiVersion": "networking.k8s.io/v1",
	"kind": "NetworkPolicy",
	"metadata": {"name": "default-deny"},
	"spec": {
		"podSelector": {"matchLabels": {"app.kubernetes.io/name": "agentbazaar", "app.kubernetes.io/instance": "t"}},
		"policyTypes": ["Ingress"],
	},
}

denials(docs) := result if {
	result := deny with input as [{"path": "rendered.yaml", "contents": docs}]
}

with_container(patch) := deployment(json.patch(good_container, patch))

denied(docs, fragment) if {
	some msg in denials(docs)
	contains(msg, fragment)
}

test_compliant_release_passes if {
	count(denials([deployment(good_container), default_deny])) == 0
}

test_a_single_document_file_is_read_too if {
	result := deny with input as [{"path": "one.yaml", "contents": deployment(good_container)}]
	some msg in result
	contains(msg, "no NetworkPolicy selects")
}

test_pods_must_run_as_non_root if {
	d := json.patch(deployment(good_container), [{"op": "replace", "path": "/spec/template/spec/securityContext", "value": {}}])
	denied([d, default_deny], "must set runAsNonRoot: true")
}

test_uid_0_is_denied_even_with_run_as_non_root if {
	denied([with_container([{"op": "add", "path": "/securityContext/runAsUser", "value": 0}]), default_deny], "must not run as uid 0")
}

test_root_filesystem_must_be_read_only if {
	denied([with_container([{"op": "replace", "path": "/securityContext/readOnlyRootFilesystem", "value": false}]), default_deny], "readOnlyRootFilesystem")
}

test_privilege_escalation_must_be_off if {
	denied([with_container([{"op": "remove", "path": "/securityContext/allowPrivilegeEscalation"}]), default_deny], "allowPrivilegeEscalation: false")
	denied([with_container([{"op": "add", "path": "/securityContext/privileged", "value": true}]), default_deny], "must not be privileged")
}

test_capabilities_must_be_dropped if {
	denied([with_container([{"op": "replace", "path": "/securityContext/capabilities/drop", "value": ["NET_RAW"]}]), default_deny], "must drop ALL")
	denied([with_container([{"op": "add", "path": "/securityContext/capabilities/add", "value": ["NET_ADMIN"]}]), default_deny], "must not add capability NET_ADMIN")
	count(denials([with_container([{"op": "add", "path": "/securityContext/capabilities/add", "value": ["NET_BIND_SERVICE"]}]), default_deny])) == 0
}

test_requests_and_limits_are_required if {
	denied([with_container([{"op": "remove", "path": "/resources/limits/cpu"}]), default_deny], "resources.limits.cpu")
	denied([with_container([{"op": "remove", "path": "/resources/requests"}]), default_deny], "resources.requests.memory")
}

test_serving_containers_need_probes if {
	denied([with_container([{"op": "remove", "path": "/readinessProbe"}]), default_deny], "must define a readinessProbe")
	denied([with_container([{"op": "remove", "path": "/livenessProbe"}]), default_deny], "must define a livenessProbe")
}

test_a_worker_without_ports_needs_no_probes if {
	worker := json.patch(good_container, [{"op": "remove", "path": "/ports"}, {"op": "remove", "path": "/readinessProbe"}, {"op": "remove", "path": "/livenessProbe"}])
	count(denials([deployment(worker), default_deny])) == 0
}

test_images_must_be_pinned if {
	denied([with_container([{"op": "replace", "path": "/image", "value": "ghcr.io/acme/api:latest"}]), default_deny], "must be pinned")
	denied([with_container([{"op": "replace", "path": "/image", "value": "ghcr.io/acme/api"}]), default_deny], "must be pinned")
	denied([with_container([{"op": "replace", "path": "/image", "value": "registry.local:5000/api"}]), default_deny], "must be pinned")
	count(denials([with_container([{"op": "replace", "path": "/image", "value": "registry.local:5000/api:1.2.3"}]), default_deny])) == 0
	digest := "ghcr.io/acme/api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
	count(denials([with_container([{"op": "replace", "path": "/image", "value": digest}]), default_deny])) == 0
}

test_every_workload_needs_a_network_policy if {
	denied([deployment(good_container)], "Deployment/api: no NetworkPolicy selects its pods")
	elsewhere := json.patch(default_deny, [{"op": "replace", "path": "/spec/podSelector/matchLabels/app.kubernetes.io~1instance", "value": "other"}])
	denied([deployment(good_container), elsewhere], "no NetworkPolicy selects")
}

test_cronjobs_and_init_containers_are_checked if {
	cronjob := {
		"apiVersion": "batch/v1",
		"kind": "CronJob",
		"metadata": {"name": "archive"},
		"spec": {"jobTemplate": {"spec": {"template": {
			"metadata": {"labels": pod_labels},
			"spec": pod_spec([json.patch(good_container, [{"op": "remove", "path": "/securityContext/readOnlyRootFilesystem"}])]),
		}}}},
	}
	denied([cronjob, default_deny], "CronJob/archive container \"api\" must set readOnlyRootFilesystem")

	init := json.patch(good_container, [{"op": "replace", "path": "/name", "value": "seed"}, {"op": "remove", "path": "/resources"}])
	d := json.patch(deployment(good_container), [{"op": "add", "path": "/spec/template/spec/initContainers", "value": [init]}])
	denied([d, default_deny], "container \"seed\" must set resources.requests.cpu")
}
