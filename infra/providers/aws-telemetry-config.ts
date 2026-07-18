/// <reference path="../../.sst/platform/config.d.ts" />

export function proxyCollectorConfig(healthAggregatorPassiveEndpoint: string | ReturnType<typeof $interpolate>) {
  return $interpolate`receivers:
  otlp:
protocols:
  http:
    endpoint: 0.0.0.0:4318
processors:
  memory_limiter:
check_interval: 1s
limit_mib: 384
spike_limit_mib: 128
  batch/axiom:
timeout: 5s
send_batch_size: 512
  batch/passive:
timeout: 5s
send_batch_size: 128
  filter/passive:
error_mode: ignore
logs:
  log_record:
    - 'body != "profound.proxy.passive_health"'
exporters:
  otlp_http/axiom_metrics:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-metrics-dataset: \${env:AXIOM_METRICS_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/axiom_logs:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-dataset: \${env:AXIOM_LOGS_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/axiom_traces:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-dataset: \${env:AXIOM_TRACES_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/passive_health:
logs_endpoint: ${healthAggregatorPassiveEndpoint}
encoding: json
compression: none
headers:
  authorization: "Bearer \${env:HEALTH_AGGREGATOR_TOKEN}"
service:
  pipelines:
metrics:
  receivers: [otlp]
  processors: [memory_limiter, batch/axiom]
  exporters: [otlp_http/axiom_metrics]
logs/axiom:
  receivers: [otlp]
  processors: [memory_limiter, batch/axiom]
  exporters: [otlp_http/axiom_logs]
logs/passive_health:
  receivers: [otlp]
  processors: [memory_limiter, filter/passive, batch/passive]
  exporters: [otlp_http/passive_health]
traces:
  receivers: [otlp]
  processors: [memory_limiter, batch/axiom]
  exporters: [otlp_http/axiom_traces]
`;
}

export function canaryCollectorConfig() {
  return $interpolate`receivers:
  otlp:
protocols:
  http:
    endpoint: 0.0.0.0:4318
processors:
  memory_limiter:
check_interval: 1s
limit_mib: 384
spike_limit_mib: 128
  batch/operational:
timeout: 5s
send_batch_size: 512
  batch/security:
timeout: 5s
send_batch_size: 512
  filter/operational:
error_mode: ignore
logs:
  log_record:
    - 'attributes["log.category"] == "security"'
  filter/security:
error_mode: ignore
logs:
  log_record:
    - 'attributes["log.category"] != "security"'
exporters:
  otlp_http/axiom_metrics:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-metrics-dataset: \${env:AXIOM_METRICS_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/axiom_operational_logs:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-dataset: \${env:AXIOM_LOGS_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/axiom_security_logs:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-dataset: \${env:AXIOM_LOGS_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
  otlp_http/axiom_traces:
endpoint: \${env:AXIOM_ENDPOINT}
compression: gzip
headers:
  authorization: "Bearer \${env:AXIOM_TOKEN}"
  x-axiom-dataset: \${env:AXIOM_TRACES_DATASET}
sending_queue: { enabled: true, num_consumers: 4, queue_size: 2048 }
retry_on_failure: { enabled: true, initial_interval: 1s, max_interval: 30s, max_elapsed_time: 5m }
service:
  pipelines:
metrics:
  receivers: [otlp]
  processors: [memory_limiter, batch/operational]
  exporters: [otlp_http/axiom_metrics]
logs/operational:
  receivers: [otlp]
  processors: [memory_limiter, filter/operational, batch/operational]
  exporters: [otlp_http/axiom_operational_logs]
logs/security:
  receivers: [otlp]
  processors: [memory_limiter, filter/security, batch/security]
  exporters: [otlp_http/axiom_security_logs]
traces:
  receivers: [otlp]
  processors: [memory_limiter, batch/operational]
  exporters: [otlp_http/axiom_traces]
`;
}
