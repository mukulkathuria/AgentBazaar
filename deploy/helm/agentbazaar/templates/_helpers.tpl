{{- define "agentbazaar.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agentbazaar.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agentbazaar.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "agentbazaar.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentbazaar
{{- end -}}

{{- /* Usage: include "agentbazaar.selectorLabels" (dict "root" $ "component" "api") */ -}}
{{- define "agentbazaar.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbazaar.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "agentbazaar.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agentbazaar.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "agentbazaar.image" -}}
{{- printf "%s:%s" .component.image.repository (default .root.Chart.AppVersion .root.Values.image.tag) -}}
{{- end -}}

{{- define "agentbazaar.secretName" -}}
{{- required "existingSecret is required: create a Secret with the app's keys first (see README.md)" .Values.existingSecret -}}
{{- end -}}

{{- /* Components this release runs: api and web always, ai when enabled. */ -}}
{{- define "agentbazaar.components" -}}
{{- $c := list "api" "web" -}}
{{- if .Values.ai.enabled -}}{{- $c = append $c "ai" -}}{{- end -}}
{{- join "," $c -}}
{{- end -}}

{{- /* Non-secret env as a YAML map: ConfigMap data, and inline env for the pre-install migration Job. */ -}}
{{- define "agentbazaar.config" -}}
{{- $cfg := deepCopy .Values.config -}}
{{- if and .Values.ai.enabled (not $cfg.AI_SERVICE_URL) -}}
{{- $_ := set $cfg "AI_SERVICE_URL" (printf "http://%s-ai:%v" (include "agentbazaar.fullname" .) .Values.ai.port) -}}
{{- end -}}
{{- range $k, $v := $cfg }}
{{- if ne (toString $v) "" }}
{{ $k }}: {{ toString $v | quote }}
{{- end }}
{{- end }}
{{- end -}}
