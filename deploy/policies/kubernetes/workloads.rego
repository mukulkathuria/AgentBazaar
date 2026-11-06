# Rules for the rendered Helm chart. Run on every values file with
#   helm template agentbazaar deploy/helm/agentbazaar -f <values> > rendered.yaml
#   conftest test --combine --policy deploy/policies/kubernetes rendered.yaml
# `--combine` hands all documents over at once, so a rule can check that a NetworkPolicy covers every workload.
package main

import rego.v1

# conftest --combine passes [{path, contents}]; contents is one document or a list of them.
documents contains doc if {
	some file in input
	is_array(file.contents)
	some doc in file.contents
	is_object(doc)
}

documents contains file.contents if {
	some file in input
	is_object(file.contents)
}

long_running := {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"}

workloads contains {"name": sprintf("%s/%s", [doc.kind, doc.metadata.name]), "kind": doc.kind, "template": doc.spec.template} if {
	some doc in documents
	doc.kind in (long_running | {"Job"})
}

workloads contains {"name": sprintf("%s/%s", [doc.kind, doc.metadata.name]), "kind": doc.kind, "template": doc.spec.jobTemplate.spec.template} if {
	some doc in documents
	doc.kind == "CronJob"
}

containers contains {"workload": w, "container": c, "init": false} if {
	some w in workloads
	some c in object.get(w.template.spec, "containers", [])
}

containers contains {"workload": w, "container": c, "init": true} if {
	some w in workloads
	some c in object.get(w.template.spec, "initContainers", [])
}

# A container setting, falling back to the pod's securityContext like the kubelet does.
setting(x, key) := object.get(x.container, ["securityContext", key], object.get(x.workload.template.spec, ["securityContext", key], null))

where(x) := sprintf("%s container %q", [x.workload.name, x.container.name])

deny contains msg if {
	some x in containers
	not setting(x, "runAsNonRoot") == true
	msg := sprintf("%s must set runAsNonRoot: true", [where(x)])
}

deny contains msg if {
	some x in containers
	setting(x, "runAsUser") == 0
	msg := sprintf("%s must not run as uid 0", [where(x)])
}

deny contains msg if {
	some x in containers
	not object.get(x.container, ["securityContext", "readOnlyRootFilesystem"], false) == true
	msg := sprintf("%s must set readOnlyRootFilesystem: true (mount an emptyDir where it writes)", [where(x)])
}

deny contains msg if {
	some x in containers
	not object.get(x.container, ["securityContext", "allowPrivilegeEscalation"], true) == false
	msg := sprintf("%s must set allowPrivilegeEscalation: false", [where(x)])
}

deny contains msg if {
	some x in containers
	object.get(x.container, ["securityContext", "privileged"], false) == true
	msg := sprintf("%s must not be privileged", [where(x)])
}

deny contains msg if {
	some x in containers
	dropped := {upper(c) | some c in object.get(x.container, ["securityContext", "capabilities", "drop"], [])}
	not "ALL" in dropped
	msg := sprintf("%s must drop ALL capabilities", [where(x)])
}

deny contains msg if {
	some x in containers
	some added in object.get(x.container, ["securityContext", "capabilities", "add"], [])
	upper(added) != "NET_BIND_SERVICE"
	msg := sprintf("%s must not add capability %s", [where(x), added])
}

deny contains msg if {
	some x in containers
	some kind in ["requests", "limits"]
	some resource in ["cpu", "memory"]
	not x.container.resources[kind][resource]
	msg := sprintf("%s must set resources.%s.%s", [where(x), kind, resource])
}

# Containers that serve traffic (declare ports) in long-running workloads need both probes.
deny contains msg if {
	some x in containers
	not x.init
	x.workload.kind in long_running
	count(object.get(x.container, "ports", [])) > 0
	some probe in ["readinessProbe", "livenessProbe"]
	not x.container[probe]
	msg := sprintf("%s serves traffic and must define a %s", [where(x), probe])
}

# A digest, or a tag that is not "latest". A ":" before the last "/" is a registry port, not a tag.
pinned(image) if contains(image, "@sha256:")

pinned(image) if {
	parts := split(image, "/")
	name := parts[count(parts) - 1]
	contains(name, ":")
	tag := split(name, ":")[1]
	tag != ""
	tag != "latest"
}

deny contains msg if {
	some x in containers
	not pinned(x.container.image)
	msg := sprintf("%s image %q must be pinned to a tag other than latest, or a digest", [where(x), x.container.image])
}

# Every workload's pods must be selected by at least one NetworkPolicy (the chart renders a default deny).
selects(policy, labels) if {
	selector := object.get(policy, ["spec", "podSelector"], {})
	not selector.matchExpressions
	every key, value in object.get(selector, "matchLabels", {}) {
		labels[key] == value
	}
}

deny contains msg if {
	some w in workloads
	labels := object.get(w.template, ["metadata", "labels"], {})
	count({p | some p in documents; p.kind == "NetworkPolicy"; selects(p, labels)}) == 0
	msg := sprintf("%s: no NetworkPolicy selects its pods", [w.name])
}
