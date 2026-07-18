/// <reference path="../../.sst/platform/config.d.ts" />

import { existsSync } from "node:fs";
import { v0Policy } from "./aws-policy.js";
import { containerHttpHealth, privateHttpLoadBalancer } from "./aws-service-config.js";
import { resolveStageConfiguration } from "../stage-config.js";

export const awsDeployment: Parameters<typeof $config>[0] = {
  app(input: { stage: string }) {
    const stage = resolveStageConfiguration(input.stage);
    return {
      name: "profound-proxy-router",
      home: "aws" as const,
      protect: stage.protect,
      removal: stage.removal,
    };
  },
  async run() {
    const stage = resolveStageConfiguration($app.stage);
    const production = stage.production;
    const cloudTestStage = stage.cloudTest;
    const devControlApiToken = "change-me";
    const devHealthAggregatorToken = "local-health-secret";
    const devCanarySigningSecret = "local-canary-secret";
    // `sst dev` reserves 127.0.0.1:1080 for its VPC tunnel.
    const socks5Port = $dev ? 1081 : 1080;
    const providerMode = stage.providerMode;
    const proxidizeExactCitySupport = providerMode === "mock" ? "provider_guaranteed" : "verifiable";
    const geoIpDatabaseSource = v0Policy.canary.geoIpDatabaseSource;
    const geoIpMetadataSource = `${geoIpDatabaseSource}.metadata.json`;
    const geoIpBundleConfigured = existsSync(geoIpDatabaseSource) && existsSync(geoIpMetadataSource);
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
    if (proxyDomain !== undefined && proxyCertificateArn === undefined) {
      throw new Error("PROXY_CERT_ARN is required when PROXY_DOMAIN enables the TLS proxy listener");
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
    const minimumTasks = stage.minimumTasks;
    const maximumTasks = stage.maximumTasks;
    const nlbTcpIdleTimeoutSeconds = v0Policy.loadBalancer.tcpIdleTimeoutSeconds;
    const nlbDeregistrationDelaySeconds = v0Policy.loadBalancer.deregistrationDelaySeconds;
    const telemetryRetentionDays = v0Policy.telemetry.retentionDays;
    const axiomEndpoint = v0Policy.telemetry.axiomEndpoint;
    const axiomDatasets = {
      logs: `${$app.name}-${$app.stage}-logs`,
      traces: `${$app.name}-${$app.stage}-traces`,
      metrics: `${$app.name}-${$app.stage}-metrics`,
    };
    const releaseImageUri = process.env.RELEASE_IMAGE_URI?.trim();
    if (releaseImageUri !== undefined && releaseImageUri !== "" && !/@sha256:[a-f0-9]{64}$/.test(releaseImageUri)) {
      throw new Error("RELEASE_IMAGE_URI must be an immutable ECR image digest URI");
    }
    const applicationImage = releaseImageUri || { context: ".", dockerfile: "Dockerfile" };
    const deploymentId = process.env.RELEASE_SHA?.trim() || `sst-${$app.stage}`;
    const partition = aws.getPartitionOutput({}).partition;

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
      ttl: "expiresAtSeconds",
      deletionProtection: production,
    });
    const deploymentNotifications = new aws.sns.Topic("DeploymentNotifications", {
      displayName: `${$app.name}-${$app.stage}-deployment-drain`,
    });
    const deploymentCoordinator = new sst.aws.Function("DeploymentCoordinator", {
      handler: "src/deployment-coordinator.handler",
      runtime: "nodejs22.x",
      timeout: "15 minutes",
      memory: "512 MB",
      environment: {
        ROUTE_TABLE_NAME: routeState.name,
        DEPLOYMENT_ID: deploymentId,
        DEPLOYMENT_NOTIFICATION_TOPIC_ARN: deploymentNotifications.arn,
      },
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
        { actions: ["sns:Publish"], resources: [deploymentNotifications.arn] },
      ],
    });
    new sst.aws.Cron("DeploymentDrainPoller", {
      schedule: "rate(15 minutes)",
      enabled: !stage.developer,
      function: deploymentCoordinator,
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
    const canaryTelemetryCollectorServiceHost = $interpolate`CanaryTelemetryCollector.${$app.stage}.${$app.name}.${canaryVpc.nodes.cloudmapNamespace.name}`;
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
        OTEL_RESOURCE_ATTRIBUTES: `service.version=0.3.0,deployment.environment.name=${$app.stage},cloud.provider=aws,cloud.platform=${cloudPlatform}`,
      };
    }

    const axiomCollectorEnvironment = {
      AXIOM_ENDPOINT: axiomEndpoint,
      AXIOM_LOGS_DATASET: axiomDatasets.logs,
      AXIOM_TRACES_DATASET: axiomDatasets.traces,
      AXIOM_METRICS_DATASET: axiomDatasets.metrics,
    };

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
    const adotImage =
      "public.ecr.aws/aws-observability/aws-otel-collector@sha256:d2bdfff2c377c3d71d78bd5d9ce9862fd535b12134a5739d87a07801297cf9fd";

    const axiomToken = containerSecret(
      "AxiomIngestToken",
      new sst.Secret("AxiomIngestToken", $dev ? "unused-in-sst-dev" : undefined).value,
      production,
    );
    const controlApiToken = containerSecret(
      "ControlApiToken",
      new sst.Secret("ControlApiToken", $dev ? devControlApiToken : undefined).value,
      production,
    );
    const controlIdentitiesSecret = stage.features.controlApiIdentities
      ? containerSecret("ControlApiIdentities", new sst.Secret("ControlApiIdentities").value, production)
      : undefined;
    const healthAggregatorToken = containerSecret(
      "HealthAggregatorToken",
      new sst.Secret("HealthAggregatorToken", $dev ? devHealthAggregatorToken : undefined).value,
      production,
    );
    const canarySigningSecretValue = new sst.Secret("CanarySigningSecret", $dev ? devCanarySigningSecret : undefined).value;
    const canarySigningSecret = containerSecret("CanarySigningSecret", canarySigningSecretValue, production);
    const providerSecrets =
      providerMode === "live"
        ? {
            BRIGHT_DATA_CUSTOMER_ID: containerSecret("BrightDataCustomerId", new sst.Secret("BrightDataCustomerId").value, production),
            BRIGHT_DATA_ZONE: containerSecret("BrightDataZone", new sst.Secret("BrightDataZone").value, production),
            BRIGHT_DATA_PASSWORD: containerSecret("BrightDataPassword", new sst.Secret("BrightDataPassword").value, production),
            BRIGHT_DATA_API_KEY: containerSecret("BrightDataApiKey", new sst.Secret("BrightDataApiKey").value, production),
            PROXIDIZE_API_TOKEN: containerSecret("ProxidizeApiToken", new sst.Secret("ProxidizeApiToken").value, production),
          }
        : undefined;
    const syntheticRouteSecrets = stage.features.syntheticHealthRoute
      ? {
          HEALTH_PROXY_USERNAME: containerSecret("HealthProxyUsername", new sst.Secret("HealthProxyUsername").value, production),
          HEALTH_PROXY_PASSWORD: containerSecret("HealthProxyPassword", new sst.Secret("HealthProxyPassword").value, production),
        }
      : undefined;
    const alertDestinationSecret = stage.features.healthAlerting
      ? containerSecret("HealthAlertDestinations", new sst.Secret("HealthAlertDestinations").value, production)
      : undefined;
    const usageAccountingSourceToken = stage.features.usageAccountingSource
      ? containerSecret("UsageAccountingSourceToken", new sst.Secret("UsageAccountingSourceToken").value, production)
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
      containers: [
        {
          name: "otel-collector",
          image: adotImage,
          environment: {
            ...axiomCollectorEnvironment,
            AOT_CONFIG_CONTENT: proxyCollectorConfig(),
          },
          ssm: { AXIOM_TOKEN: axiomToken, HEALTH_AGGREGATOR_TOKEN: healthAggregatorToken },
          logging: { retention: "1 month" },
        },
      ],
      serviceRegistry: { port: 4318 },
      scaling: { min: 1, max: production ? 3 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [
            {
              name: "ReadTelemetrySecrets",
              policy: aws.iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [axiomToken, healthAggregatorToken],
                  },
                ],
              }).json,
            },
          ];
        },
      },
    });

    const canaryTelemetryCollector = new sst.aws.Service("CanaryTelemetryCollector", {
      cluster: canaryCluster,
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      containers: [
        {
          name: "otel-collector",
          image: adotImage,
          environment: {
            ...axiomCollectorEnvironment,
            AOT_CONFIG_CONTENT: canaryCollectorConfig(),
          },
          ssm: { AXIOM_TOKEN: axiomToken },
          logging: { retention: "1 month" },
        },
      ],
      serviceRegistry: { port: 4318 },
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [
            {
              name: "ReadCanaryTelemetrySecret",
              policy: aws.iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [axiomToken],
                  },
                ],
              }).json,
            },
          ];
        },
      },
    });

    // Native ECS blue/green needs two target groups per listener. SST still
    // owns the task definition and service, while these raw resources expose
    // the alternate target groups required by the ECS deployment strategy.
    const proxyLoadBalancerSecurityGroup = new aws.ec2.SecurityGroup("ProxyLoadBalancerSecurityGroup", {
      vpcId: vpc.id,
      description: "Restrict the private proxy listeners to approved client networks",
      ingress: [...portIngress(8080, dataPlaneCidrs), ...portIngress(1080, dataPlaneCidrs)],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    });
    const proxyTaskSecurityGroup = new aws.ec2.SecurityGroup("ProxyTaskSecurityGroup", {
      vpcId: vpc.id,
      description: "Accept proxy traffic only from the data-plane load balancer",
      ingress: [
        {
          protocol: "tcp",
          fromPort: 8080,
          toPort: 8080,
          securityGroups: [proxyLoadBalancerSecurityGroup.id],
        },
        {
          protocol: "tcp",
          fromPort: 1080,
          toPort: 1080,
          securityGroups: [proxyLoadBalancerSecurityGroup.id],
        },
      ],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    });
    const proxyLoadBalancer = new aws.lb.LoadBalancer("ProxyLoadBalancer", {
      internal: true,
      loadBalancerType: "network",
      subnets: vpc.privateSubnets,
      securityGroups: [proxyLoadBalancerSecurityGroup.id],
      enableCrossZoneLoadBalancing: true,
    });
    const targetGroupDefaults = {
      protocol: "TCP",
      targetType: "ip",
      vpcId: vpc.id,
      deregistrationDelay: nlbDeregistrationDelaySeconds,
      connectionTermination: false,
      preserveClientIp: "false",
      healthCheck: {
        enabled: true,
        protocol: "TCP",
        interval: 30,
        healthyThreshold: 3,
        unhealthyThreshold: 3,
      },
    } as const;
    const httpBlueTarget = new aws.lb.TargetGroup("ProxyHttpBlueTarget", {
      ...targetGroupDefaults,
      port: 8080,
    });
    const httpGreenTarget = new aws.lb.TargetGroup("ProxyHttpGreenTarget", {
      ...targetGroupDefaults,
      port: 8080,
    });
    const socksBlueTarget = new aws.lb.TargetGroup("ProxySocksBlueTarget", {
      ...targetGroupDefaults,
      port: 1080,
    });
    const socksGreenTarget = new aws.lb.TargetGroup("ProxySocksGreenTarget", {
      ...targetGroupDefaults,
      port: 1080,
    });
    const httpListener = new aws.lb.Listener("ProxyHttpListener", {
      loadBalancerArn: proxyLoadBalancer.arn,
      port: 8080,
      protocol: tlsEnabled ? "TLS" : "TCP",
      certificateArn: tlsEnabled ? proxyCertificateArn : undefined,
      tcpIdleTimeoutSeconds: tlsEnabled ? undefined : nlbTcpIdleTimeoutSeconds,
      defaultActions: [{ type: "forward", targetGroupArn: httpBlueTarget.arn }],
    });
    const socksListener = new aws.lb.Listener("ProxySocksListener", {
      loadBalancerArn: proxyLoadBalancer.arn,
      port: 1080,
      protocol: "TCP",
      tcpIdleTimeoutSeconds: nlbTcpIdleTimeoutSeconds,
      defaultActions: [{ type: "forward", targetGroupArn: socksBlueTarget.arn }],
    });
    const ecsInfrastructureRole = new aws.iam.Role("ProxyEcsInfrastructureRole", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs.amazonaws.com" }),
    });
    new aws.iam.RolePolicyAttachment("ProxyEcsInfrastructureLoadBalancerPolicy", {
      role: ecsInfrastructureRole.name,
      policyArn: $interpolate`arn:${partition}:iam::aws:policy/AmazonECSInfrastructureRolePolicyForLoadBalancers`,
    });
    const ecsLifecycleHookRole = new aws.iam.Role("ProxyEcsLifecycleHookRole", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs.amazonaws.com" }),
      inlinePolicies: [
        {
          name: "InvokeDeploymentCoordinator",
          policy: deploymentCoordinator.arn.apply((functionArn) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: functionArn }],
            }),
          ),
        },
      ],
    });

    const service = new sst.aws.Service("ProxyRouter", {
      cluster,
      dev: { url: "http://127.0.0.1:8080" },
      architecture: "x86_64",
      cpu: "1 vCPU",
      memory: "2 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: applicationImage,
          cpu: "0.75 vCPU",
          memory: "1.5 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "data-plane",
            PROVIDER_MODE: providerMode,
            ROUTE_TABLE_NAME: routeState.name,
            DEPLOYMENT_ID: deploymentId,
            FORWARD_PROXY_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            FORWARD_PROXY_PORT: "8080",
            SOCKS5_PROXY_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            SOCKS5_PROXY_PORT: String(socks5Port),
            CONTROL_API_DISABLED: "true",
            ADVERTISED_PROXY_HOST: proxyDomain ?? "internal-proxy.invalid",
            ADVERTISED_HTTP_PROXY_PROTOCOL: tlsEnabled ? "https" : "http",
            ALLOWED_TARGET_PORTS: v0Policy.routing.allowedTargetPorts,
            CONNECT_TIMEOUT_MS: v0Policy.routing.connectTimeoutMs,
            OPERATION_TIMEOUT_MS: v0Policy.routing.operationTimeoutMs,
            STREAM_IDLE_TIMEOUT_MS: String(nlbTcpIdleTimeoutSeconds * 1_000),
            RETRY_MAX_ATTEMPTS: v0Policy.routing.retryMaxAttempts,
            PROXIDIZE_EXACT_CITY_SUPPORT: proxidizeExactCitySupport,
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
      scaling: {
        min: minimumTasks,
        max: maximumTasks,
        cpuUtilization: 60,
        memoryUtilization: 70,
      },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies =
            proxyContainerSecretArns.length === 0
              ? []
              : [
                  {
                    name: "ReadContainerSecrets",
                    policy: aws.iam.getPolicyDocumentOutput({
                      statements: [
                        {
                          actions: ["secretsmanager:GetSecretValue"],
                          resources: proxyContainerSecretArns,
                        },
                      ],
                    }).json,
                  },
                ];
        },
        service(args) {
          args.networkConfiguration = {
            assignPublicIp: true,
            subnets: vpc.publicSubnets,
            securityGroups: [proxyTaskSecurityGroup.id],
          };
          args.deploymentCircuitBreaker = undefined;
          args.deploymentConfiguration = {
            strategy: "BLUE_GREEN",
            bakeTimeInMinutes: "360",
            lifecycleHooks: [
              {
                hookTargetArn: deploymentCoordinator.arn,
                roleArn: ecsLifecycleHookRole.arn,
                lifecycleStages: ["POST_PRODUCTION_TRAFFIC_SHIFT"],
                hookDetails: JSON.stringify({ policy: "durable-tunnel-drain", pollIntervalMinutes: 15 }),
              },
            ],
          };
          args.loadBalancers = [
            {
              containerName: "app",
              containerPort: 8080,
              targetGroupArn: httpBlueTarget.arn,
              advancedConfiguration: {
                alternateTargetGroupArn: httpGreenTarget.arn,
                productionListenerRule: httpListener.arn,
                roleArn: ecsInfrastructureRole.arn,
              },
            },
            {
              containerName: "app",
              containerPort: 1080,
              targetGroupArn: socksBlueTarget.arn,
              advancedConfiguration: {
                alternateTargetGroupArn: socksGreenTarget.arn,
                productionListenerRule: socksListener.arn,
                roleArn: ecsInfrastructureRole.arn,
              },
            },
          ];
        },
      },
    });
    const host = $dev ? "127.0.0.1" : (proxyDomain ?? proxyLoadBalancer.dnsName);

    const controlPlane = new sst.aws.Service("ControlPlane", {
      cluster,
      dev: { url: "http://127.0.0.1:8081" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: applicationImage,
          cpu: "0.5 vCPU",
          memory: "1 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "control-plane",
            PROVIDER_MODE: providerMode,
            ROUTE_TABLE_NAME: routeState.name,
            FORWARD_PROXY_PORT: "8080",
            SOCKS5_PROXY_PORT: String(socks5Port),
            CONTROL_API_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            CONTROL_API_PORT: "8081",
            CONTROL_API_USER_ID: `sst:${$app.stage}`,
            ADVERTISED_PROXY_HOST: host,
            ADVERTISED_HTTP_PROXY_PROTOCOL: tlsEnabled ? "https" : "http",
            CONNECT_TIMEOUT_MS: v0Policy.routing.connectTimeoutMs,
            OPERATION_TIMEOUT_MS: v0Policy.routing.operationTimeoutMs,
            RETRY_MAX_ATTEMPTS: v0Policy.routing.retryMaxAttempts,
            PROXIDIZE_EXACT_CITY_SUPPORT: proxidizeExactCitySupport,
            ...otelEnvironment(`profound-proxy-control-${$app.stage}`, telemetryCollectorEndpoint),
            ...($dev ? { CONTROL_API_TOKEN: devControlApiToken } : {}),
          },
          ssm: controlAppSsm,
          health: containerHttpHealth(8081, "/health/ready", "30 seconds"),
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: {
        public: false,
        ...(controlDomain === undefined
          ? {}
          : {
              domain:
                controlCertificateArn === undefined
                  ? controlDomain
                  : { name: controlDomain, dns: false as const, cert: controlCertificateArn },
            }),
        rules: [
          {
            listen: controlDomain === undefined ? "80/http" : "443/https",
            forward: "8081/http",
            container: "app",
          },
        ],
        health: { "8081/http": { path: "/health/ready", interval: "30 seconds" } },
      },
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [
            {
              name: "ReadControlSecrets",
              policy: aws.iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: controlContainerSecretArns,
                  },
                ],
              }).json,
            },
          ];
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
            throttlingBurstLimit: v0Policy.canary.throttleBurst,
            throttlingRateLimit: v0Policy.canary.throttleRate,
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
        CANARY_REQUESTS_PER_MINUTE: v0Policy.canary.requestsPerMinute,
        GEOIP_DATABASE_PATH: "./data/GeoLite2-City.mmdb",
        GEOIP_MAX_ACCURACY_RADIUS_KM: v0Policy.canary.geoIpMaxAccuracyRadiusKm,
        OTEL_EXPORTER_OTLP_ENDPOINT: canaryTelemetryCollectorEndpoint,
        OTEL_SERVICE_NAME: `profound-proxy-canary-${$app.stage}`,
        DEPLOYMENT_ENVIRONMENT: $app.stage,
      },
    });

    // Every non-production stage gets a request-priced recipient for semantic,
    // HTTPS CONNECT, SOCKS5, and telemetry checks. The dedicated TTL table
    // makes replay detection reliable across Lambda cold starts and concurrency.
    // It intentionally remains outside every VPC: that prevents access to the
    // product network while preserving access to the DynamoDB service endpoint.
    const integrationTargetState = production
      ? undefined
      : new sst.aws.Dynamo("IntegrationTargetState", {
          fields: { id: "string" },
          primaryIndex: { hashKey: "id" },
          ttl: "expiresAt",
        });
    const integrationTargetApi = production
      ? undefined
      : new sst.aws.ApiGatewayV2("IntegrationTargetApi", {
          cors: false,
          accessLog: { retention: "1 week" },
          transform: {
            stage(args) {
              args.defaultRouteSettings = {
                throttlingBurstLimit: 30,
                throttlingRateLimit: 10,
              };
            },
          },
        });
    const integrationTargetRoute =
      integrationTargetApi === undefined || integrationTargetState === undefined
        ? undefined
        : integrationTargetApi.route("$default", {
            handler: "src/integration-target-lambda.handler",
            runtime: "nodejs22.x",
            timeout: "10 seconds",
            memory: "512 MB",
            concurrency: { reserved: 5 },
            permissions: [
              {
                actions: ["dynamodb:UpdateItem"],
                resources: [integrationTargetState.arn],
              },
            ],
            environment: {
              INTEGRATION_TARGET_TABLE_NAME: integrationTargetState.name,
            },
          });

    // CI stages additionally retain a conventional plain-HTTP socket origin.
    // It is short-lived with the CI stack and validates behavior that an API
    // Gateway/Lambda event adapter cannot represent faithfully.
    const integrationTransportTarget = cloudTestStage
      ? new sst.aws.Service("IntegrationTransportTarget", {
          cluster: canaryCluster,
          architecture: "x86_64",
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          containers: [
            {
              name: "app",
              image: applicationImage,
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
            },
          ],
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
          image: applicationImage,
          cpu: "0.75 vCPU",
          memory: "1.5 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "health-aggregator",
            PROVIDER_MODE: providerMode,
            ROUTE_TABLE_NAME: routeState.name,
            CONTROL_API_HOST: "127.0.0.1",
            HEALTH_AGGREGATOR_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            HEALTH_AGGREGATOR_PORT: "8082",
            HEALTH_PROVIDER_REFRESH_MS: v0Policy.health.providerRefreshMs,
            HEALTH_PASSIVE_MAX_AGE_MS: v0Policy.health.passiveMaxAgeMs,
            HEALTH_SYNTHETIC_COOLDOWN_MS: v0Policy.health.syntheticCooldownMs,
            HEALTH_ALERT_DEGRADED_DELAY_MS: v0Policy.health.alertDegradedDelayMs,
            HEALTH_ALERT_WEBHOOK_TIMEOUT_MS: v0Policy.health.alertWebhookTimeoutMs,
            HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS: v0Policy.health.alertWebhookMaxAttempts,
            HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS: v0Policy.health.alertWebhookInitialBackoffMs,
            HEALTH_ALERT_DESTINATION_IDS: v0Policy.health.alertDestinationIds,
            HEALTH_ALERT_CONFIGURATION_VERSION: v0Policy.health.alertConfigurationVersion,
            HEALTH_CANARY_URL: $interpolate`${canaryApi.url}/v1/challenge`,
            ...(syntheticRouteSecrets === undefined
              ? {}
              : {
                  HEALTH_PROXY_URL: $interpolate`${tlsEnabled ? "https" : "http"}://${host}:8080`,
                }),
            CONNECT_TIMEOUT_MS: v0Policy.routing.connectTimeoutMs,
            PROXIDIZE_EXACT_CITY_SUPPORT: proxidizeExactCitySupport,
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
          health: containerHttpHealth(8082, "/health/ready", "30 seconds"),
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: privateHttpLoadBalancer(8082, "/health/ready"),
      scaling: { min: 1, max: 1 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [
            {
              name: "ReadHealthSecrets",
              policy: aws.iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: aggregatorSecrets,
                  },
                ],
              }).json,
            },
          ];
        },
      },
    });

    const status = new sst.aws.Service("CompanyDashboard", {
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
          image: applicationImage,
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "status",
            ROUTE_TABLE_NAME: routeState.name,
            STATUS_APP_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            STATUS_APP_PORT: "8083",
            STATUS_STALE_AFTER_MS: v0Policy.health.statusStaleAfterMs,
            HEALTH_AGGREGATOR_URL: healthAggregator.url,
            ...otelEnvironment(`profound-proxy-status-${$app.stage}`, telemetryCollectorEndpoint),
            ...($dev ? { HEALTH_AGGREGATOR_TOKEN: devHealthAggregatorToken } : {}),
          },
          ssm: { HEALTH_AGGREGATOR_TOKEN: healthAggregatorToken },
          health: containerHttpHealth(8083, "/health/live"),
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: privateHttpLoadBalancer(8083, "/health/live"),
      scaling: { min: 1, max: production ? 2 : 1, cpuUtilization: 60, memoryUtilization: 70 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies = [
            {
              name: "ReadStatusSecrets",
              policy: aws.iam.getPolicyDocumentOutput({
                statements: [
                  {
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [healthAggregatorToken],
                  },
                ],
              }).json,
            },
          ];
        },
      },
    });

    const usageAccounting = new sst.aws.Service("UsageAccounting", {
      cluster,
      dev: { url: "http://127.0.0.1:8085" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: applicationImage,
          cpu: "0.5 vCPU",
          memory: "1 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "usage-accounting",
            ROUTE_TABLE_NAME: routeState.name,
            USAGE_ACCOUNTING_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            USAGE_ACCOUNTING_PORT: "8085",
            USAGE_ACCOUNTING_INTERVAL_MS: v0Policy.usageAccounting.intervalMs,
            PROVIDER_COST_TOTALS_JSON: v0Policy.usageAccounting.providerCostTotalsJson,
            PROVISIONED_PROXY_SLOT_CAPACITY_JSON: v0Policy.usageAccounting.provisionedProxySlotCapacityJson,
            ...(v0Policy.usageAccounting.sourceUrl === undefined
              ? {}
              : { USAGE_ACCOUNTING_SOURCE_URL: v0Policy.usageAccounting.sourceUrl }),
            USAGE_ACCOUNTING_SOURCE_TIMEOUT_MS: v0Policy.usageAccounting.sourceTimeoutMs,
            USAGE_VARIANCE_ABSOLUTE_FLOOR_USD: v0Policy.usageAccounting.varianceAbsoluteFloorUsd,
            USAGE_VARIANCE_WARNING_RELATIVE: v0Policy.usageAccounting.varianceWarningRelative,
            USAGE_VARIANCE_ERROR_RELATIVE: v0Policy.usageAccounting.varianceErrorRelative,
            ...otelEnvironment(`profound-proxy-usage-accounting-${$app.stage}`, telemetryCollectorEndpoint),
          },
          ssm: usageAccountingSourceToken === undefined ? {} : { USAGE_ACCOUNTING_SOURCE_TOKEN: usageAccountingSourceToken },
          health: containerHttpHealth(8085, "/health/ready"),
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: privateHttpLoadBalancer(8085, "/health/ready"),
      scaling: { min: 1, max: 1 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies =
            usageAccountingSourceToken === undefined
              ? []
              : [
                  {
                    name: "ReadUsageAccountingSourceSecret",
                    policy: aws.iam.getPolicyDocumentOutput({
                      statements: [
                        {
                          actions: ["secretsmanager:GetSecretValue"],
                          resources: [usageAccountingSourceToken],
                        },
                      ],
                    }).json,
                  },
                ];
        },
      },
    });

    const notification = new sst.aws.Service("NotificationService", {
      cluster,
      dev: { url: "http://127.0.0.1:8084" },
      architecture: "x86_64",
      cpu: "0.5 vCPU",
      memory: "1 GB",
      permissions: [
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [routeState.arn, $interpolate`${routeState.arn}/index/*`],
        },
      ],
      containers: [
        {
          name: "app",
          image: applicationImage,
          cpu: "0.5 vCPU",
          memory: "1 GB",
          dev: { command: "pnpm dev:service" },
          environment: {
            NODE_ENV: "production",
            SERVICE_MODE: "notification",
            ROUTE_TABLE_NAME: routeState.name,
            NOTIFICATION_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
            NOTIFICATION_PORT: "8084",
            NOTIFICATION_POLL_INTERVAL_MS: v0Policy.notification.pollIntervalMs,
            HEALTH_ALERT_WEBHOOK_TIMEOUT_MS: v0Policy.health.alertWebhookTimeoutMs,
            HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS: v0Policy.health.alertWebhookMaxAttempts,
            HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS: v0Policy.health.alertWebhookInitialBackoffMs,
            ...otelEnvironment(`profound-proxy-notification-${$app.stage}`, telemetryCollectorEndpoint),
          },
          ssm: alertDestinationSecret === undefined ? {} : { HEALTH_ALERT_DESTINATIONS_JSON: alertDestinationSecret },
          health: containerHttpHealth(8084, "/health/ready"),
          logging: { retention: "1 month" },
        },
      ],
      loadBalancer: privateHttpLoadBalancer(8084, "/health/ready"),
      scaling: { min: 1, max: 1 },
      wait: true,
      transform: {
        executionRole(args) {
          args.inlinePolicies =
            alertDestinationSecret === undefined
              ? []
              : [
                  {
                    name: "ReadNotificationSecret",
                    policy: aws.iam.getPolicyDocumentOutput({
                      statements: [
                        {
                          actions: ["secretsmanager:GetSecretValue"],
                          resources: [alertDestinationSecret],
                        },
                      ],
                    }).json,
                  },
                ];
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
            schemaVersion: 3,
            app: $app.name,
            stage: $app.stage,
            expiresAt: stage.cloudTest ? new Date(Date.now() + 24 * 60 * 60_000).toISOString() : undefined,
            deploymentProvider: "aws",
            region,
            providerMode,
            geoIpBundleConfigured,
            routeTable: routeState.name,
            deploymentId,
            deploymentNotificationTopic: deploymentNotifications.arn,
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
            socks5Proxy: $interpolate`socks5h://${host}:${socks5Port}`,
            controlApi: controlPlane.url,
            publicCanary: canaryApi.url,
            statusApplication: status.url,
            companyDashboard: status.url,
            usageAccounting: usageAccounting.url,
            healthAggregator: healthAggregator.url,
            productVpcId: vpc.id,
            canaryVpcId: canaryVpc.id,
            services: {
              proxy: {
                cluster: cluster.nodes.cluster.name,
                service: service.nodes.service.name,
                taskDefinition: service.nodes.taskDefinition.arn,
                taskRole: service.nodes.taskRole.arn,
                executionRole: required(service.nodes.executionRole, "proxy execution role").arn,
              },
              controlPlane: {
                cluster: cluster.nodes.cluster.name,
                service: controlPlane.nodes.service.name,
                taskDefinition: controlPlane.nodes.taskDefinition.arn,
                taskRole: controlPlane.nodes.taskRole.arn,
                executionRole: required(controlPlane.nodes.executionRole, "control-plane execution role").arn,
              },
              healthAggregator: {
                cluster: cluster.nodes.cluster.name,
                service: healthAggregator.nodes.service.name,
                taskDefinition: healthAggregator.nodes.taskDefinition.arn,
                taskRole: healthAggregator.nodes.taskRole.arn,
                executionRole: required(healthAggregator.nodes.executionRole, "health-aggregator execution role").arn,
              },
              status: {
                cluster: cluster.nodes.cluster.name,
                service: status.nodes.service.name,
                taskDefinition: status.nodes.taskDefinition.arn,
                taskRole: status.nodes.taskRole.arn,
                executionRole: required(status.nodes.executionRole, "status execution role").arn,
              },
              usageAccounting: {
                cluster: cluster.nodes.cluster.name,
                service: usageAccounting.nodes.service.name,
                taskDefinition: usageAccounting.nodes.taskDefinition.arn,
                taskRole: usageAccounting.nodes.taskRole.arn,
                executionRole: required(usageAccounting.nodes.executionRole, "usage-accounting execution role").arn,
              },
              notification: {
                cluster: cluster.nodes.cluster.name,
                service: notification.nodes.service.name,
                taskDefinition: notification.nodes.taskDefinition.arn,
                taskRole: notification.nodes.taskRole.arn,
                executionRole: required(notification.nodes.executionRole, "notification execution role").arn,
              },
              telemetry: {
                cluster: cluster.nodes.cluster.name,
                service: telemetryCollector.nodes.service.name,
                taskDefinition: telemetryCollector.nodes.taskDefinition.arn,
                taskRole: telemetryCollector.nodes.taskRole.arn,
                executionRole: required(telemetryCollector.nodes.executionRole, "telemetry execution role").arn,
              },
              canaryTelemetry: {
                cluster: canaryCluster.nodes.cluster.name,
                service: canaryTelemetryCollector.nodes.service.name,
                taskDefinition: canaryTelemetryCollector.nodes.taskDefinition.arn,
                taskRole: canaryTelemetryCollector.nodes.taskRole.arn,
                executionRole: required(canaryTelemetryCollector.nodes.executionRole, "canary telemetry execution role").arn,
              },
            },
            canary: {
              compute: "lambda",
              api: "api-gateway-v2",
              apiId: canaryApi.nodes.api.id,
              functionArn: canaryRoute.nodes.function.arn,
              geoIpPackaged: geoIpBundleConfigured,
            },
            integrationTarget:
              integrationTargetApi === undefined || integrationTargetRoute === undefined || integrationTargetState === undefined
                ? null
                : {
                    url: integrationTargetApi.url,
                    compute: "lambda",
                    api: "api-gateway-v2",
                    apiId: integrationTargetApi.nodes.api.id,
                    functionArn: integrationTargetRoute.nodes.function.arn,
                    stateTable: integrationTargetState.name,
                  },
            integrationTransportTarget:
              integrationTransportTarget === undefined
                ? null
                : {
                    url: integrationTransportTarget.url,
                    compute: "ecs-fargate",
                    cluster: canaryCluster.nodes.cluster.name,
                    service: integrationTransportTarget.nodes.service.name,
                    taskDefinition: integrationTransportTarget.nodes.taskDefinition.arn,
                  },
          }),
        });

    return {
      proxyHost: host,
      loadBalancerHost: $dev ? "not-deployed-in-sst-dev" : proxyLoadBalancer.dnsName,
      httpProxy: $interpolate`${tlsEnabled ? "https" : "http"}://${host}:8080`,
      socks5Proxy: $interpolate`socks5h://${host}:${socks5Port}`,
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
      companyDashboard: status.url,
      usageAccounting: usageAccounting.url,
      healthAggregator: healthAggregator.url,
      publicCanary: canaryApi.url,
      integrationTarget: integrationTargetApi?.url ?? "not-deployed",
      integrationTransportTarget: integrationTransportTarget?.url ?? "not-deployed",
      integrationMetadataParameter: integrationMetadata?.name ?? "not-deployed-in-sst-dev",
      deploymentNotificationTopic: deploymentNotifications.arn,
    };
  },
};

function cidrs(value: string | undefined): string[] {
  const result = (value ?? "0.0.0.0/0")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (result.length === 0) throw new Error("Allowed CIDR lists must not be empty");
  return result;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function portIngress(port: number, allowedCidrs: string[]): aws.types.input.ec2.SecurityGroupIngress[] {
  return allowedCidrs.map((cidrBlock) => ({
    protocol: "tcp",
    fromPort: port,
    toPort: port,
    cidrBlocks: [cidrBlock],
  }));
}

function containerSecret(name: string, value: InstanceType<typeof sst.Secret>["value"], production: boolean) {
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
