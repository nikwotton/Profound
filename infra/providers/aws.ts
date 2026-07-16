/// <reference path="../../.sst/platform/config.d.ts" />

import { existsSync } from "node:fs";

export const awsDeployment: Parameters<typeof $config>[0] = {
  app(input: { stage: string }) {
    return {
      name: "profound-proxy-router",
      home: "aws" as const,
      protect: input.stage === "production",
      removal: input.stage === "production" ? "retain" as const : "remove" as const,
    };
  },
  async run() {
    const production = $app.stage === "production";
    const devControlApiToken = "change-me";
    const devHealthAggregatorToken = "local-health-secret";
    const devCanarySigningSecret = "local-canary-secret";
    const providerMode = process.env.PROVIDER_MODE ?? (production ? "live" : "mock");
    const integrationTargetEnabled = process.env.DEPLOY_INTEGRATION_TARGET === "true";
    const geoIpDatabaseSource = process.env.GEOIP_DATABASE_SOURCE?.trim() || ".sst/geoip/GeoLite2-City.mmdb";
    const geoIpMetadataSource = `${geoIpDatabaseSource}.metadata.json`;
    const geoIpBundleConfigured = existsSync(geoIpDatabaseSource) && existsSync(geoIpMetadataSource);
    if (providerMode !== "mock" && providerMode !== "live") {
      throw new Error("PROVIDER_MODE must be mock or live");
    }
    if (production && integrationTargetEnabled) {
      throw new Error("DEPLOY_INTEGRATION_TARGET is forbidden in production");
    }
    if (production && !geoIpBundleConfigured) {
      throw new Error("Run pnpm geoip:prepare before production deployment so the canary bundle includes GeoLite2 City");
    }

    const proxyDomain = process.env.PROXY_DOMAIN?.trim() || undefined;
    const proxyCertificateArn = process.env.PROXY_CERT_ARN?.trim() || undefined;
    const controlDomain = process.env.CONTROL_DOMAIN?.trim() || undefined;
    const controlCertificateArn = process.env.CONTROL_CERT_ARN?.trim() || undefined;
    if (production && proxyDomain === undefined) {
      throw new Error("PROXY_DOMAIN is required for production so proxy credentials use TLS");
    }
    if (production && controlDomain === undefined) {
      throw new Error("CONTROL_DOMAIN is required for production so control API tokens use TLS");
    }
    if (production && process.env.CONTROL_PLANE_ALLOWED_CIDRS === undefined) {
      throw new Error("CONTROL_PLANE_ALLOWED_CIDRS must be set explicitly for production");
    }
    if (production && process.env.DATA_PLANE_ALLOWED_CIDRS === undefined) {
      throw new Error("DATA_PLANE_ALLOWED_CIDRS must be set explicitly for production");
    }
    const tlsEnabled = proxyDomain !== undefined;
    const dataPlaneCidrs = cidrs(process.env.DATA_PLANE_ALLOWED_CIDRS);
    const controlPlaneCidrs = cidrs(process.env.CONTROL_PLANE_ALLOWED_CIDRS);
    const minimumTasks = positiveInteger(process.env.MIN_TASKS, production ? 2 : 1, "MIN_TASKS");
    const maximumTasks = positiveInteger(process.env.MAX_TASKS, production ? 4 : 2, "MAX_TASKS");
    const nlbTcpIdleTimeoutSeconds = boundedInteger(
      process.env.NLB_TCP_IDLE_TIMEOUT_SECONDS,
      1_200,
      "NLB_TCP_IDLE_TIMEOUT_SECONDS",
      60,
      6_000,
    );
    const nlbDeregistrationDelaySeconds = boundedInteger(
      process.env.NLB_DEREGISTRATION_DELAY_SECONDS,
      300,
      "NLB_DEREGISTRATION_DELAY_SECONDS",
      0,
      3_600,
    );
    const telemetryRetentionDays = positiveInteger(
      process.env.TELEMETRY_RETENTION_DAYS,
      30,
      "TELEMETRY_RETENTION_DAYS",
    );
    const axiomEndpoint = normalizedHttpsOrigin(
      process.env.AXIOM_OTLP_ENDPOINT ?? "https://api.axiom.co",
      "AXIOM_OTLP_ENDPOINT",
    );
    const axiomDatasets = {
      logs: datasetName(process.env.AXIOM_LOGS_DATASET, `${$app.name}-${$app.stage}-logs`, "AXIOM_LOGS_DATASET"),
      traces: datasetName(
        process.env.AXIOM_TRACES_DATASET,
        `${$app.name}-${$app.stage}-traces`,
        "AXIOM_TRACES_DATASET",
      ),
      metrics: datasetName(
        process.env.AXIOM_METRICS_DATASET,
        `${$app.name}-${$app.stage}-metrics`,
        "AXIOM_METRICS_DATASET",
      ),
    };
    if (maximumTasks < minimumTasks) throw new Error("MAX_TASKS must be greater than or equal to MIN_TASKS");

    const routeState = new sst.aws.Dynamo("RouteState", {
      fields: {
        pk: "string",
        sk: "string",
        entity: "string",
        createdAt: "string",
        gsi1pk: "string",
        gsi1sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        EntityCreatedAt: { hashKey: "entity", rangeKey: "createdAt" },
        EndpointAssignments: { hashKey: "gsi1pk", rangeKey: "gsi1sk" },
      },
      deletionProtection: production,
    });

    // The bastion is required by `sst tunnel` so operators and the deployed
    // integration suite can reach the internal status and health endpoints.
    const vpc = new sst.aws.Vpc("Network", { bastion: true });
    const cluster = new sst.aws.Cluster("Cluster", { vpc });
    // The public canary is deliberately isolated in an unpeered VPC so its
    // runtime has no route into the proxy, status, or health-aggregator VPC.
    const canaryVpc = new sst.aws.Vpc("CanaryNetwork");
    const canaryCluster = new sst.aws.Cluster("CanaryCluster", { vpc: canaryVpc });
    const region = aws.getRegionOutput().name;
    const healthAggregatorServiceHost = $interpolate`HealthAggregator.${$app.stage}.${$app.name}.${vpc.nodes.cloudmapNamespace.name}`;
    const healthAggregatorPassiveEndpoint = $interpolate`http://${healthAggregatorServiceHost}:8082/v1/passive-signals/otlp`;
    const telemetryCollectorServiceHost = $interpolate`TelemetryCollector.${$app.stage}.${$app.name}.${vpc.nodes.cloudmapNamespace.name}`;
    const telemetryCollectorEndpoint = $interpolate`http://${telemetryCollectorServiceHost}:4318`;
    const canaryTelemetryCollectorServiceHost =
      $interpolate`CanaryTelemetryCollector.${$app.stage}.${$app.name}.${canaryVpc.nodes.cloudmapNamespace.name}`;
    const canaryTelemetryCollectorEndpoint = $interpolate`http://${canaryTelemetryCollectorServiceHost}:4318`;

    function otelEnvironment(
      serviceName: string,
      endpoint: string | ReturnType<typeof $interpolate>,
      cloudPlatform = "aws_ecs",
    ): Record<string, string | ReturnType<typeof $interpolate>> {
      if ($dev) return { OTEL_SERVICE_NAME: serviceName };
      return {
        OTEL_SERVICE_NAME: serviceName,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_LOG_LEVEL: "error",
        OTEL_NODE_EXPERIMENTAL_SDK_METRICS: "true",
        OTEL_METRIC_EXPORT_INTERVAL: "30000",
        OTEL_BSP_SCHEDULE_DELAY: "5000",
        OTEL_RESOURCE_ATTRIBUTES:
          `service.version=0.3.0,deployment.environment.name=${$app.stage},cloud.provider=aws,cloud.platform=${cloudPlatform}`,
      };
    }

    const axiomCollectorEnvironment = {
      AXIOM_ENDPOINT: axiomEndpoint,
      AXIOM_LOGS_DATASET: axiomDatasets.logs,
      AXIOM_TRACES_DATASET: axiomDatasets.traces,
      AXIOM_METRICS_DATASET: axiomDatasets.metrics,
    };

    function axiomCollectorConfig() {
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
  batch:
    timeout: 5s
    send_batch_size: 512
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
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/axiom_metrics]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/axiom_logs]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/axiom_traces]
`;
    }

    function proxyCollectorConfig() {
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

    function canaryCollectorConfig() {
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
    const adotImage = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:d2bdfff2c377c3d71d78bd5d9ce9862fd535b12134a5739d87a07801297cf9fd";

    const axiomToken = containerSecret(
      "AxiomIngestToken",
      new sst.Secret("AxiomIngestToken").value,
      production,
    );
    const controlApiToken = containerSecret(
      "ControlApiToken",
      new sst.Secret("ControlApiToken").value,
      production,
    );
    const controlIdentitiesSecret = process.env.CONTROL_API_IDENTITIES_CONFIGURED === "true"
      ? containerSecret(
          "ControlApiIdentities",
          new sst.Secret("ControlApiIdentities").value,
          production,
        )
      : undefined;
    const healthAggregatorToken = containerSecret(
      "HealthAggregatorToken",
      new sst.Secret("HealthAggregatorToken").value,
      production,
    );
    const canarySigningSecretValue = new sst.Secret("CanarySigningSecret").value;
    const canarySigningSecret = containerSecret(
      "CanarySigningSecret",
      canarySigningSecretValue,
      production,
    );
    const providerSecrets = providerMode === "live"
      ? {
          BRIGHT_DATA_CUSTOMER_ID: containerSecret(
            "BrightDataCustomerId",
            new sst.Secret("BrightDataCustomerId").value,
            production,
          ),
          BRIGHT_DATA_ZONE: containerSecret(
            "BrightDataZone",
            new sst.Secret("BrightDataZone").value,
            production,
          ),
          BRIGHT_DATA_PASSWORD: containerSecret(
            "BrightDataPassword",
            new sst.Secret("BrightDataPassword").value,
            production,
          ),
          BRIGHT_DATA_API_KEY: containerSecret(
            "BrightDataApiKey",
            new sst.Secret("BrightDataApiKey").value,
            production,
          ),
          PROXIDIZE_API_TOKEN: containerSecret(
            "ProxidizeApiToken",
            new sst.Secret("ProxidizeApiToken").value,
            production,
          ),
        }
      : undefined;
    const syntheticRouteSecrets = process.env.HEALTH_SYNTHETIC_ROUTE_CONFIGURED === "true"
      ? {
          HEALTH_PROXY_USERNAME: containerSecret(
            "HealthProxyUsername",
            new sst.Secret("HealthProxyUsername").value,
            production,
          ),
          HEALTH_PROXY_PASSWORD: containerSecret(
            "HealthProxyPassword",
            new sst.Secret("HealthProxyPassword").value,
            production,
          ),
        }
      : undefined;
    const alertDestinationSecret = process.env.HEALTH_ALERTING_CONFIGURED === "true"
      ? containerSecret(
          "HealthAlertDestinations",
          new sst.Secret("HealthAlertDestinations").value,
          production,
        )
      : undefined;
    const proxyContainerSecretArns = providerSecrets === undefined ? [] : Object.values(providerSecrets);
    const controlContainerSecretArns = [
      controlApiToken,
      ...(controlIdentitiesSecret === undefined ? [] : [controlIdentitiesSecret]),
      ...proxyContainerSecretArns,
    ];
    const proxyAppSsm = providerSecrets ?? {};
    const controlAppSsm = {
      CONTROL_API_TOKEN: controlApiToken,
      ...(controlIdentitiesSecret === undefined ? {} : { CONTROL_API_IDENTITIES_JSON: controlIdentitiesSecret }),
      ...(providerSecrets ?? {}),
    };

    const telemetryCollector = new sst.aws.Service("TelemetryCollector", {
      cluster,
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      containers: [{
        name: "otel-collector",
        image: adotImage,
        environment: {
          ...axiomCollectorEnvironment,
          AOT_CONFIG_CONTENT: proxyCollectorConfig(),
        },
        ssm: { AXIOM_TOKEN: axiomToken, HEALTH_AGGREGATOR_TOKEN: healthAggregatorToken },
        logging: { retention: "1 month" },
      }],
      serviceRegistry: { port: 4318 },
      scaling: { min: 1, max: production ? 3 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [{
            name: "ReadTelemetrySecrets",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: [axiomToken, healthAggregatorToken],
            }] }).json,
          }];
        },
      },
    });

    const canaryTelemetryCollector = new sst.aws.Service("CanaryTelemetryCollector", {
      cluster: canaryCluster,
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      containers: [{
        name: "otel-collector",
        image: adotImage,
        environment: {
          ...axiomCollectorEnvironment,
          AOT_CONFIG_CONTENT: canaryCollectorConfig(),
        },
        ssm: { AXIOM_TOKEN: axiomToken },
        logging: { retention: "1 month" },
      }],
      serviceRegistry: { port: 4318 },
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [{
            name: "ReadCanaryTelemetrySecret",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: [axiomToken],
            }] }).json,
          }];
        },
      },
    });

    const service = new sst.aws.Service("ProxyRouter", {
      cluster,
      dev: { url: "http://127.0.0.1:8081" },
      architecture: "x86_64",
      cpu: "1 vCPU",
      memory: "2 GB",
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:TransactWriteItems",
            "dynamodb:Query",
          ],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: { context: ".", dockerfile: "Dockerfile" },
          cpu: "0.75 vCPU",
          memory: "1.5 GB",
          dev: { command: "pnpm dev" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "data-plane",
            PROVIDER_MODE: providerMode,
            PERSISTENCE_BACKEND: "dynamodb",
            ROUTE_TABLE_NAME: routeState.name,
            FORWARD_PROXY_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            FORWARD_PROXY_PORT: "8080",
            SOCKS5_PROXY_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            SOCKS5_PROXY_PORT: "1080",
            CONTROL_API_DISABLED: "true",
            ADVERTISED_PROXY_HOST: proxyDomain ?? "internal-proxy.invalid",
            ADVERTISED_HTTP_PROXY_PROTOCOL: tlsEnabled ? "https" : "http",
            ALLOWED_TARGET_PORTS: process.env.ALLOWED_TARGET_PORTS ?? "80,443",
            CONNECT_TIMEOUT_MS: process.env.CONNECT_TIMEOUT_MS ?? "10000",
            OPERATION_TIMEOUT_MS: process.env.OPERATION_TIMEOUT_MS ?? "30000",
            STREAM_IDLE_TIMEOUT_MS: process.env.STREAM_IDLE_TIMEOUT_MS ?? String(nlbTcpIdleTimeoutSeconds * 1_000),
            RETRY_MAX_ATTEMPTS: process.env.RETRY_MAX_ATTEMPTS ?? "4",
            PROXIDIZE_EXACT_CITY_SUPPORT: process.env.PROXIDIZE_EXACT_CITY_SUPPORT ??
              (providerMode === "mock" ? "provider_guaranteed" : "unsupported"),
            ...otelEnvironment(`profound-proxy-router-${$app.stage}`, telemetryCollectorEndpoint),
          },
          ssm: proxyAppSsm,
          health: {
            command: [
              "CMD-SHELL",
              "node -e \"const s=require('node:net').connect(8080,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)\"",
            ],
            startPeriod: "30 seconds",
            interval: "30 seconds",
            timeout: "5 seconds",
            retries: 3,
          },
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: {
        public: false,
        ...(proxyDomain === undefined
          ? {}
          : {
              domain: proxyCertificateArn === undefined
                ? proxyDomain
                : { name: proxyDomain, dns: false as const, cert: proxyCertificateArn },
            }),
        rules: [
          tlsEnabled
            ? { listen: "8080/tls", forward: "8080/tcp", container: "app" }
            : { listen: "8080/tcp", forward: "8080/tcp", container: "app" },
          { listen: "1080/tcp", forward: "1080/tcp", container: "app" },
        ],
        health: {
          "8080/tcp": { interval: "30 seconds" },
          "1080/tcp": { interval: "30 seconds" },
        },
      },
      scaling: {
        min: minimumTasks,
        max: maximumTasks,
        cpuUtilization: 60,
        memoryUtilization: 70,
      },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = proxyContainerSecretArns.length === 0 ? [] : [{
            name: "ReadContainerSecrets",
            policy: aws.iam.getPolicyDocumentOutput({
              statements: [{
                actions: ["secretsmanager:GetSecretValue"],
                resources: proxyContainerSecretArns,
              }],
            }).json,
          }];
        },
        listener(args) {
          // AWS exposes a configurable idle timeout only for TCP listeners. TLS
          // listeners have a fixed 350-second idle timeout.
          if (args.protocol === "TCP") {
            args.tcpIdleTimeoutSeconds = nlbTcpIdleTimeoutSeconds;
          }
        },
        target(args) {
          args.deregistrationDelay = nlbDeregistrationDelaySeconds;
          args.connectionTermination = false;
        },
        loadBalancerSecurityGroup(args) {
          args.ingress = [
            ...portIngress(8080, dataPlaneCidrs),
            ...portIngress(1080, dataPlaneCidrs),
          ];
        },
      },
    });
    const host = proxyDomain ?? service.url.apply((value) => new URL(value).hostname);

    const controlPlane = new sst.aws.Service("ControlPlane", {
      cluster,
      dev: { url: "http://127.0.0.1:8081" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:TransactWriteItems",
            "dynamodb:Query",
          ],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: { context: ".", dockerfile: "Dockerfile" },
          cpu: "0.5 vCPU",
          memory: "1 GB",
          dev: { command: "pnpm dev" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "control-plane",
            PROVIDER_MODE: providerMode,
            PERSISTENCE_BACKEND: "dynamodb",
            ROUTE_TABLE_NAME: routeState.name,
            FORWARD_PROXY_PORT: "8080",
            SOCKS5_PROXY_PORT: "1080",
            CONTROL_API_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            CONTROL_API_PORT: "8081",
            CONTROL_API_USER_ID: process.env.CONTROL_API_USER_ID ?? `sst:${$app.stage}`,
            ADVERTISED_PROXY_HOST: host,
            ADVERTISED_HTTP_PROXY_PROTOCOL: tlsEnabled ? "https" : "http",
            CONNECT_TIMEOUT_MS: process.env.CONNECT_TIMEOUT_MS ?? "10000",
            OPERATION_TIMEOUT_MS: process.env.OPERATION_TIMEOUT_MS ?? "30000",
            RETRY_MAX_ATTEMPTS: process.env.RETRY_MAX_ATTEMPTS ?? "4",
            PROXIDIZE_EXACT_CITY_SUPPORT: process.env.PROXIDIZE_EXACT_CITY_SUPPORT ??
              (providerMode === "mock" ? "provider_guaranteed" : "unsupported"),
            ...otelEnvironment(`profound-proxy-control-${$app.stage}`, telemetryCollectorEndpoint),
            ...($dev ? { CONTROL_API_TOKEN: devControlApiToken } : {}),
          },
          ssm: controlAppSsm,
          health: {
            command: [
              "CMD-SHELL",
              "node -e \"fetch('http://127.0.0.1:8081/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            ],
            startPeriod: "30 seconds",
            interval: "30 seconds",
            timeout: "5 seconds",
            retries: 3,
          },
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: {
        public: false,
        ...(controlDomain === undefined
          ? {}
          : {
              domain: controlCertificateArn === undefined
                ? controlDomain
                : { name: controlDomain, dns: false as const, cert: controlCertificateArn },
            }),
        rules: [{
          listen: controlDomain === undefined ? "80/http" : "443/https",
          forward: "8081/http",
          container: "app",
        }],
        health: { "8081/http": { path: "/health/ready", interval: "30 seconds" } },
      },
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [{
            name: "ReadControlSecrets",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: controlContainerSecretArns,
            }] }).json,
          }];
        },
        loadBalancerSecurityGroup(args) {
          args.ingress = portIngress(controlDomain === undefined ? 80 : 443, controlPlaneCidrs);
        },
      },
    });

    const canaryApi = new sst.aws.ApiGatewayV2("PublicCanary", {
      cors: false,
      accessLog: { retention: "1 month" },
      transform: {
        stage(args) {
          args.defaultRouteSettings = {
            throttlingBurstLimit: positiveInteger(
              process.env.CANARY_THROTTLE_BURST,
              30,
              "CANARY_THROTTLE_BURST",
            ),
            throttlingRateLimit: positiveInteger(
              process.env.CANARY_THROTTLE_RATE,
              10,
              "CANARY_THROTTLE_RATE",
            ),
          };
        },
      },
    });
    const canaryRoute = canaryApi.route("ANY /{proxy+}", {
      handler: "src/canary-lambda.handler",
      runtime: "nodejs22.x",
      vpc: canaryVpc,
      timeout: "10 seconds",
      memory: "1 GB",
      copyFiles: geoIpBundleConfigured
        ? [
            { from: geoIpDatabaseSource, to: "data/GeoLite2-City.mmdb" },
            { from: geoIpMetadataSource, to: "data/GeoLite2-City.mmdb.metadata.json" },
          ]
        : [],
      environment: {
        CANARY_SIGNING_SECRET: canarySigningSecretValue,
        CANARY_REQUESTS_PER_MINUTE: process.env.CANARY_REQUESTS_PER_MINUTE ?? "60",
        GEOIP_DATABASE_PATH: "./data/GeoLite2-City.mmdb",
        GEOIP_MAX_ACCURACY_RADIUS_KM: process.env.GEOIP_MAX_ACCURACY_RADIUS_KM ?? "100",
        OTEL_EXPORTER_OTLP_ENDPOINT: canaryTelemetryCollectorEndpoint,
        OTEL_SERVICE_NAME: `profound-proxy-canary-${$app.stage}`,
        DEPLOYMENT_ENVIRONMENT: $app.stage,
      },
    });

    const integrationTarget = integrationTargetEnabled
      ? new sst.aws.Service("IntegrationTarget", {
          cluster: canaryCluster,
          architecture: "x86_64",
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          containers: [{
            name: "app",
            image: { context: ".", dockerfile: "Dockerfile" },
            environment: {
              NODE_ENV: "production",
              SERVICE_MODE: "integration-target",
              ALLOW_INTEGRATION_TARGET: "true",
              INTEGRATION_TARGET_HOST: "0.0.0.0",
              INTEGRATION_TARGET_PORT: "8091",
              OTEL_SDK_DISABLED: "true",
            },
            health: {
              command: [
                "CMD-SHELL",
                "node -e \"fetch('http://127.0.0.1:8091/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
              ],
              startPeriod: "20 seconds",
              interval: "30 seconds",
              timeout: "5 seconds",
              retries: 3,
            },
            logging: { retention: "1 week" },
          }],
          loadBalancer: {
            public: true,
            rules: [{ listen: "80/tcp", forward: "8091/tcp", container: "app" }],
            health: { "8091/tcp": { interval: "30 seconds" } },
          },
          scaling: { min: 1, max: 1 },
          wait: true,
        })
      : undefined;

    const aggregatorSecrets = [
      healthAggregatorToken,
      canarySigningSecret,
      ...(providerSecrets === undefined ? [] : Object.values(providerSecrets)),
      ...(syntheticRouteSecrets === undefined ? [] : Object.values(syntheticRouteSecrets)),
    ];
    const healthAggregator = new sst.aws.Service("HealthAggregator", {
      cluster,
      dev: { url: "http://127.0.0.1:8082" },
      architecture: "x86_64",
      cpu: "1 vCPU",
      memory: "2 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: { context: ".", dockerfile: "Dockerfile" },
          cpu: "0.75 vCPU",
          memory: "1.5 GB",
          dev: { command: "pnpm dev" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "health-aggregator",
            PROVIDER_MODE: providerMode,
            PERSISTENCE_BACKEND: "dynamodb",
            ROUTE_TABLE_NAME: routeState.name,
            CONTROL_API_HOST: "127.0.0.1",
            HEALTH_AGGREGATOR_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            HEALTH_AGGREGATOR_PORT: "8082",
            HEALTH_PROVIDER_REFRESH_MS: process.env.HEALTH_PROVIDER_REFRESH_MS ?? "60000",
            HEALTH_PASSIVE_MAX_AGE_MS: process.env.HEALTH_PASSIVE_MAX_AGE_MS ?? "300000",
            HEALTH_SYNTHETIC_COOLDOWN_MS: process.env.HEALTH_SYNTHETIC_COOLDOWN_MS ?? "300000",
            HEALTH_ALERT_DEGRADED_DELAY_MS: process.env.HEALTH_ALERT_DEGRADED_DELAY_MS ?? "300000",
            HEALTH_ALERT_WEBHOOK_TIMEOUT_MS: process.env.HEALTH_ALERT_WEBHOOK_TIMEOUT_MS ?? "5000",
            HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS: process.env.HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS ?? "5",
            HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS:
              process.env.HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS ?? "1000",
            HEALTH_ALERT_DESTINATION_IDS: process.env.HEALTH_ALERT_DESTINATION_IDS ?? "",
            HEALTH_ALERT_CONFIGURATION_VERSION: process.env.HEALTH_ALERT_CONFIGURATION_VERSION ?? "unconfigured",
            HEALTH_CANARY_URL: $interpolate`${canaryApi.url}/v1/challenge`,
            ...(syntheticRouteSecrets === undefined ? {} : {
              HEALTH_PROXY_URL: $interpolate`${tlsEnabled ? "https" : "http"}://${host}:8080`,
            }),
            CONNECT_TIMEOUT_MS: process.env.CONNECT_TIMEOUT_MS ?? "10000",
            PROXIDIZE_EXACT_CITY_SUPPORT: process.env.PROXIDIZE_EXACT_CITY_SUPPORT ??
              (providerMode === "mock" ? "provider_guaranteed" : "unsupported"),
            ...otelEnvironment(`profound-proxy-health-${$app.stage}`, telemetryCollectorEndpoint),
            ...($dev
              ? {
                  CONTROL_API_TOKEN: devHealthAggregatorToken,
                  HEALTH_AGGREGATOR_TOKEN: devHealthAggregatorToken,
                  CANARY_SIGNING_SECRET: devCanarySigningSecret,
                }
              : {}),
          },
          ssm: {
            CONTROL_API_TOKEN: healthAggregatorToken,
            HEALTH_AGGREGATOR_TOKEN: healthAggregatorToken,
            CANARY_SIGNING_SECRET: canarySigningSecret,
            ...(providerSecrets ?? {}),
            ...(syntheticRouteSecrets ?? {}),
          },
          health: {
            command: [
              "CMD-SHELL",
              "node -e \"fetch('http://127.0.0.1:8082/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            ],
            startPeriod: "30 seconds",
            interval: "30 seconds",
            timeout: "5 seconds",
            retries: 3,
          },
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: {
        public: false,
        rules: [{ listen: "80/http", forward: "8082/http", container: "app" }],
        health: { "8082/http": { path: "/health/ready", interval: "30 seconds" } },
      },
      scaling: { min: 1, max: 1 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [{
            name: "ReadHealthSecrets",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: aggregatorSecrets,
            }] }).json,
          }];
        },
      },
    });

    const status = new sst.aws.Service("StatusApplication", {
      cluster,
      dev: { url: "http://127.0.0.1:8083" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: { context: ".", dockerfile: "Dockerfile" },
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          dev: { command: "pnpm dev" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "status",
            PERSISTENCE_BACKEND: "dynamodb",
            ROUTE_TABLE_NAME: routeState.name,
            STATUS_APP_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            STATUS_APP_PORT: "8083",
            STATUS_STALE_AFTER_MS: process.env.STATUS_STALE_AFTER_MS ?? "300000",
            HEALTH_AGGREGATOR_URL: healthAggregator.url,
            ...otelEnvironment(`profound-proxy-status-${$app.stage}`, telemetryCollectorEndpoint),
            ...($dev ? { HEALTH_AGGREGATOR_TOKEN: devHealthAggregatorToken } : {}),
          },
          ssm: { HEALTH_AGGREGATOR_TOKEN: healthAggregatorToken },
          health: {
            command: [
              "CMD-SHELL",
              "node -e \"fetch('http://127.0.0.1:8083/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            ],
            startPeriod: "20 seconds",
            interval: "30 seconds",
            timeout: "5 seconds",
            retries: 3,
          },
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: {
        public: false,
        rules: [{ listen: "80/http", forward: "8083/http", container: "app" }],
        health: { "8083/http": { path: "/health/live", interval: "30 seconds" } },
      },
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [{
            name: "ReadStatusSecrets",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: [healthAggregatorToken],
            }] }).json,
          }];
        },
      },
    });

    const notification = new sst.aws.Service("NotificationService", {
      cluster,
      dev: { url: "http://127.0.0.1:8084" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [{
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
      }],
      containers: [{
        name: "app",
        image: { context: ".", dockerfile: "Dockerfile" },
        cpu: "0.5 vCPU",
        memory: "1 GB",
        dev: { command: "pnpm dev" },
        environment: {
          NODE_ENV: "production",
          SERVICE_MODE: "notification",
          PERSISTENCE_BACKEND: "dynamodb",
          ROUTE_TABLE_NAME: routeState.name,
          NOTIFICATION_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
          NOTIFICATION_PORT: "8084",
          NOTIFICATION_POLL_INTERVAL_MS: process.env.NOTIFICATION_POLL_INTERVAL_MS ?? "5000",
          HEALTH_ALERT_WEBHOOK_TIMEOUT_MS: process.env.HEALTH_ALERT_WEBHOOK_TIMEOUT_MS ?? "5000",
          HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS: process.env.HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS ?? "5",
          HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS:
            process.env.HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS ?? "1000",
          ...otelEnvironment(`profound-proxy-notification-${$app.stage}`, telemetryCollectorEndpoint),
        },
        ssm: alertDestinationSecret === undefined
          ? {}
          : { HEALTH_ALERT_DESTINATIONS_JSON: alertDestinationSecret },
        health: {
          command: [
            "CMD-SHELL",
            "node -e \"fetch('http://127.0.0.1:8084/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
          ],
          startPeriod: "20 seconds",
          interval: "30 seconds",
          timeout: "5 seconds",
          retries: 3,
        },
        logging: { retention: "1 month" },
      }],
      loadBalancer: {
        public: false,
        rules: [{ listen: "80/http", forward: "8084/http", container: "app" }],
        health: { "8084/http": { path: "/health/ready", interval: "30 seconds" } },
      },
      scaling: { min: 1, max: 1 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = alertDestinationSecret === undefined ? [] : [{
            name: "ReadNotificationSecret",
            policy: aws.iam.getPolicyDocumentOutput({ statements: [{
              actions: ["secretsmanager:GetSecretValue"],
              resources: [alertDestinationSecret],
            }] }).json,
          }];
        },
      },
    });

    const integrationMetadataParameterName = `/sst/${$app.name}/${$app.stage}/deployed-integration`;
    const integrationMetadata = $dev
      ? undefined
      : new aws.ssm.Parameter("DeployedIntegrationMetadata", {
          name: integrationMetadataParameterName,
          type: "String",
          value: $jsonStringify({
            schemaVersion: 2,
            app: $app.name,
            stage: $app.stage,
            deploymentProvider: "aws",
            region,
            providerMode,
            geoIpBundleConfigured,
            routeTable: routeState.name,
            compute: {
              orchestration: "ecs",
              launchType: "FARGATE",
              expansionPath: ["ECS_MANAGED_INSTANCES", "EC2"],
            },
            proxyTransport: {
              loadBalancer: "network",
              scheme: "internal",
              httpListenerIdleTimeoutSeconds: tlsEnabled ? 350 : nlbTcpIdleTimeoutSeconds,
              socks5ListenerIdleTimeoutSeconds: nlbTcpIdleTimeoutSeconds,
              deregistrationDelaySeconds: nlbDeregistrationDelaySeconds,
              connectionTerminationOnDeregistration: false,
            },
            telemetry: {
              backend: "axiom",
              endpoint: axiomEndpoint,
              datasets: axiomDatasets,
              retentionDays: telemetryRetentionDays,
            },
            httpProxy: $interpolate`${tlsEnabled ? "https" : "http"}://${host}:8080`,
            socks5Proxy: $interpolate`socks5h://${host}:1080`,
            controlApi: controlPlane.url,
            publicCanary: canaryApi.url,
            statusApplication: status.url,
            healthAggregator: healthAggregator.url,
            productVpcId: vpc.id,
            canaryVpcId: canaryVpc.id,
            services: {
              proxy: {
                cluster: cluster.nodes.cluster.name,
                service: service.nodes.service.name,
                taskDefinition: service.nodes.taskDefinition.arn,
                taskRole: service.nodes.taskRole.arn,
                executionRole: service.nodes.executionRole!.arn,
              },
              controlPlane: {
                cluster: cluster.nodes.cluster.name,
                service: controlPlane.nodes.service.name,
                taskDefinition: controlPlane.nodes.taskDefinition.arn,
                taskRole: controlPlane.nodes.taskRole.arn,
                executionRole: controlPlane.nodes.executionRole!.arn,
              },
              healthAggregator: {
                cluster: cluster.nodes.cluster.name,
                service: healthAggregator.nodes.service.name,
                taskDefinition: healthAggregator.nodes.taskDefinition.arn,
                taskRole: healthAggregator.nodes.taskRole.arn,
                executionRole: healthAggregator.nodes.executionRole!.arn,
              },
              status: {
                cluster: cluster.nodes.cluster.name,
                service: status.nodes.service.name,
                taskDefinition: status.nodes.taskDefinition.arn,
                taskRole: status.nodes.taskRole.arn,
                executionRole: status.nodes.executionRole!.arn,
              },
              notification: {
                cluster: cluster.nodes.cluster.name,
                service: notification.nodes.service.name,
                taskDefinition: notification.nodes.taskDefinition.arn,
                taskRole: notification.nodes.taskRole.arn,
                executionRole: notification.nodes.executionRole!.arn,
              },
              telemetry: {
                cluster: cluster.nodes.cluster.name,
                service: telemetryCollector.nodes.service.name,
                taskDefinition: telemetryCollector.nodes.taskDefinition.arn,
                taskRole: telemetryCollector.nodes.taskRole.arn,
                executionRole: telemetryCollector.nodes.executionRole!.arn,
              },
              canaryTelemetry: {
                cluster: canaryCluster.nodes.cluster.name,
                service: canaryTelemetryCollector.nodes.service.name,
                taskDefinition: canaryTelemetryCollector.nodes.taskDefinition.arn,
                taskRole: canaryTelemetryCollector.nodes.taskRole.arn,
                executionRole: canaryTelemetryCollector.nodes.executionRole!.arn,
              },
            },
            canary: {
              compute: "lambda",
              api: "api-gateway-v2",
              apiId: canaryApi.nodes.api.id,
              functionArn: canaryRoute.nodes.function.arn,
              geoIpPackaged: geoIpBundleConfigured,
            },
            integrationTarget: integrationTarget === undefined
              ? null
              : {
                  url: integrationTarget.url,
                  cluster: canaryCluster.nodes.cluster.name,
                  service: integrationTarget.nodes.service.name,
                  taskDefinition: integrationTarget.nodes.taskDefinition.arn,
                },
          }),
        });

    return {
      proxyHost: host,
      loadBalancerHost: $dev ? "not-deployed-in-sst-dev" : service.nodes.loadBalancer.dnsName,
      httpProxy: $interpolate`${tlsEnabled ? "https" : "http"}://${host}:8080`,
      socks5Proxy: $interpolate`socks5h://${host}:1080`,
      controlApi: controlPlane.url,
      apiDocs: $interpolate`${controlPlane.url}/docs`,
      providerMode,
      routeTable: routeState.name,
      deploymentProvider: "aws",
      telemetryBackend: "axiom",
      axiomEndpoint,
      axiomDatasets,
      telemetryRetentionDays,
      statusApplication: status.url,
      healthAggregator: healthAggregator.url,
      publicCanary: canaryApi.url,
      integrationTarget: integrationTarget?.url ?? "not-deployed",
      integrationMetadataParameter: integrationMetadata?.name ?? "not-deployed-in-sst-dev",
    };
  },
};

function cidrs(value: string | undefined): string[] {
  const result = (value ?? "0.0.0.0/0").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (result.length === 0) throw new Error("Allowed CIDR lists must not be empty");
  return result;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizedHttpsOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function datasetName(value: string | undefined, fallback: string, name: string): string {
  const result = (value ?? fallback).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) {
    throw new Error(`${name} must be 1-128 characters using letters, digits, dots, underscores, or hyphens`);
  }
  return result;
}

function portIngress(port: number, allowedCidrs: string[]): aws.types.input.ec2.SecurityGroupIngress[] {
  return allowedCidrs.map((cidrBlock) => ({
    protocol: "tcp",
    fromPort: port,
    toPort: port,
    cidrBlocks: [cidrBlock],
  }));
}

function containerSecret(
  name: string,
  value: InstanceType<typeof sst.Secret>["value"],
  production: boolean,
) {
  const secret = new aws.secretsmanager.Secret(`${name}ContainerSecret`, {
    description: `Managed by SST for ${$app.name}/${$app.stage}`,
    recoveryWindowInDays: production ? 30 : 0,
  });
  const version = new aws.secretsmanager.SecretVersion(`${name}ContainerSecretVersion`, {
    secretId: secret.id,
    secretString: value,
  });
  return secret.arn.apply((arn) => version.id.apply(() => arn));
}
