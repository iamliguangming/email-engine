{{- define "pintalent-mail.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pintalent-mail.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "pintalent-mail.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pintalent-mail.labels" -}}
helm.sh/chart: {{ include "pintalent-mail.chart" . }}
app.kubernetes.io/name: {{ include "pintalent-mail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "pintalent-mail.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pintalent-mail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pintalent-mail.apiName" -}}
{{- printf "%s-api" (include "pintalent-mail.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pintalent-mail.workerName" -}}
{{- printf "%s-worker" (include "pintalent-mail.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pintalent-mail.postgresName" -}}
{{- printf "%s-postgres" (include "pintalent-mail.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pintalent-mail.secretName" -}}
{{- default (printf "%s-runtime" (include "pintalent-mail.fullname" .)) .Values.existingSecret }}
{{- end }}

{{- define "pintalent-mail.runtimeEnv" -}}
- name: MAIL_PG_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "pintalent-mail.secretName" . }}
      key: MAIL_PG_PASSWORD
- name: DATABASE_URL
  value: "postgres://{{ .Values.postgresql.auth.username }}:$(MAIL_PG_PASSWORD)@{{ include "pintalent-mail.postgresName" . }}:{{ .Values.postgresql.port }}/{{ .Values.postgresql.auth.database }}"
- name: MAIL_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "pintalent-mail.secretName" . }}
      key: MAIL_SECRET
- name: MAIL_ADMIN_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "pintalent-mail.secretName" . }}
      key: MAIL_ADMIN_TOKEN
- name: MAIL_HOST_GATEWAY_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "pintalent-mail.secretName" . }}
      key: MAIL_HOST_GATEWAY_SECRET
- name: MAIL_HOST_GATEWAY_URL
  value: {{ required "api.hostGatewayUrl is required" .Values.api.hostGatewayUrl | quote }}
{{- end }}
