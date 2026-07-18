import assert from "node:assert/strict";
import {
  axiomJson,
  awsJson,
  createRoute,
  deployedEnvironment,
  deployedTest,
  requestViaHttpProxy,
  revokeRoute,
  waitFor,
} from "./helpers.js";

interface EcsService {
  serviceName?: string;
  status?: string;
  desiredCount?: number;
  runningCount?: number;
  taskDefinition?: string;
  deployments?: Array<{ status?: string; runningCount?: number; desiredCount?: number }>;
  networkConfiguration?: { awsvpcConfiguration?: { subnets?: string[] } };
  loadBalancers?: Array<{ targetGroupArn?: string }>;
  launchType?: string;
  capacityProviderStrategy?: Array<{ capacityProvider?: string }>;
}

interface ContainerDefinition {
  name?: string;
  image?: string;
  environment?: Array<{ name?: string; value?: string }>;
  secrets?: Array<{ name?: string; valueFrom?: string }>;
}

interface TaskDefinition {
  taskDefinitionArn?: string;
  taskRoleArn?: string;
  executionRoleArn?: string;
  containerDefinitions?: ContainerDefinition[];
}

async function describeService(cluster: string, service: string, region: string): Promise<EcsService> {
  const result = await awsJson<{ services?: EcsService[] }>(
    ["ecs", "describe-services", "--cluster", cluster, "--services", service],
    region,
  );
  const described = result.services?.[0];
  if (described === undefined) throw new Error(`ECS service ${cluster}/${service} was not found`);
  return described;
}

async function describeTaskDefinition(taskDefinition: string, region: string): Promise<TaskDefinition> {
  const result = await awsJson<{ taskDefinition?: TaskDefinition }>(
    ["ecs", "describe-task-definition", "--task-definition", taskDefinition],
    region,
  );
  if (result.taskDefinition === undefined) throw new Error(`Task definition ${taskDefinition} was not found`);
  return result.taskDefinition;
}

function environmentOf(container: ContainerDefinition | undefined): Record<string, string> {
  return Object.fromEntries(
    (container?.environment ?? [])
      .filter((entry): entry is { name: string; value: string } => entry.name !== undefined && entry.value !== undefined)
      .map(({ name, value }) => [name, value]),
  );
}

async function loadBalancerSchemes(service: EcsService, region: string): Promise<string[]> {
  const targetGroups = (service.loadBalancers ?? []).flatMap(({ targetGroupArn }) =>
    targetGroupArn === undefined ? [] : [targetGroupArn],
  );
  if (targetGroups.length === 0) return [];
  const groups = await awsJson<{ TargetGroups?: Array<{ LoadBalancerArns?: string[] }> }>(
    ["elbv2", "describe-target-groups", "--target-group-arns", ...targetGroups],
    region,
  );
  const loadBalancers = [...new Set((groups.TargetGroups ?? []).flatMap(({ LoadBalancerArns }) => LoadBalancerArns ?? []))];
  const described = await awsJson<{ LoadBalancers?: Array<{ Scheme?: string }> }>(
    ["elbv2", "describe-load-balancers", "--load-balancer-arns", ...loadBalancers],
    region,
  );
  return (described.LoadBalancers ?? []).flatMap(({ Scheme }) => (Scheme === undefined ? [] : [Scheme]));
}

deployedTest("deployed ECS components are independent Fargate services with dedicated telemetry collectors", async () => {
  const environment = await deployedEnvironment();
  const metadata = environment.metadata;
  assert.equal(metadata.deploymentProvider, "aws");
  assert.equal(metadata.telemetry.backend, "axiom");
  const entries = Object.entries(metadata.services);
  assert.equal(new Set(entries.map(([, service]) => service.service)).size, entries.length);
  assert.equal(new Set(entries.map(([, service]) => service.taskRole)).size, entries.length);
  assert.equal(metadata.services.proxy.cluster, metadata.services.healthAggregator.cluster);
  assert.equal(metadata.services.proxy.cluster, metadata.services.status.cluster);
  assert.equal(metadata.services.proxy.cluster, metadata.services.controlPlane.cluster);
  assert.equal(metadata.services.proxy.cluster, metadata.services.notification.cluster);
  assert.equal(metadata.services.proxy.cluster, metadata.services.telemetry.cluster);
  assert.notEqual(metadata.services.proxy.cluster, metadata.services.canaryTelemetry.cluster);
  assert.equal(metadata.compute.launchType, "FARGATE");
  assert.deepEqual(metadata.compute.expansionPath, ["ECS_MANAGED_INSTANCES", "EC2"]);

  for (const [name, serviceMetadata] of entries) {
    const service = await describeService(serviceMetadata.cluster, serviceMetadata.service, environment.region);
    assert.equal(service.status, "ACTIVE", `${name} is not active`);
    assert.ok((service.desiredCount ?? 0) >= 1, `${name} has no desired tasks`);
    assert.equal(service.runningCount, service.desiredCount, `${name} is not fully running`);
    assert.equal(service.taskDefinition, serviceMetadata.taskDefinition);
    assert.ok(
      service.launchType === "FARGATE" ||
        service.capacityProviderStrategy?.some(
          ({ capacityProvider }) => capacityProvider === "FARGATE" || capacityProvider === "FARGATE_SPOT",
        ),
      `${name} is not running on Fargate`,
    );

    const task = await describeTaskDefinition(serviceMetadata.taskDefinition, environment.region);
    assert.equal(task.taskRoleArn, serviceMetadata.taskRole);
    assert.equal(task.executionRoleArn, serviceMetadata.executionRole);
    const telemetryService = name === "telemetry" || name === "canaryTelemetry";
    assert.deepEqual(
      task.containerDefinitions?.map(({ name: containerName }) => containerName).sort(),
      telemetryService ? ["otel-collector"] : ["app"],
    );
    if (telemetryService) {
      const collector = task.containerDefinitions?.[0];
      assert.match(collector?.image ?? "", /^public\.ecr\.aws\/aws-observability\/aws-otel-collector@sha256:[a-f0-9]{64}$/);
      const collectorEnvironment = environmentOf(collector);
      assert.match(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /endpoint: 0\.0\.0\.0:4318/);
      assert.match(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /otlp_http\/axiom_/);
      assert.match(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /sending_queue/);
      assert.match(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /retry_on_failure/);
      assert.doesNotMatch(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /sigv4auth|cloudwatch|x-aws-/i);
      assert.doesNotMatch(collectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /tail_sampling|probabilistic_sampler/);
      assert.equal(collectorEnvironment["AXIOM_ENDPOINT"], metadata.telemetry.endpoint);
      assert.equal(collectorEnvironment["AXIOM_LOGS_DATASET"], metadata.telemetry.datasets.logs);
      assert.equal(collectorEnvironment["AXIOM_SECURITY_LOGS_DATASET"], undefined);
      assert.equal(collectorEnvironment["AXIOM_TRACES_DATASET"], metadata.telemetry.datasets.traces);
      assert.equal(collectorEnvironment["AXIOM_METRICS_DATASET"], metadata.telemetry.datasets.metrics);
      assert.deepEqual(
        collector?.secrets
          ?.map(({ name: secretName }) => secretName)
          .filter(Boolean)
          .sort(),
        name === "telemetry" ? ["AXIOM_TOKEN", "HEALTH_AGGREGATOR_TOKEN"] : ["AXIOM_TOKEN"],
      );
    } else {
      const appEnvironment = environmentOf(task.containerDefinitions?.[0]);
      assert.match(appEnvironment["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "", /^http:\/\/TelemetryCollector\./);
      assert.equal(appEnvironment["OTEL_LOGS_EXPORTER"], "otlp");
      assert.equal(appEnvironment["OTEL_METRICS_EXPORTER"], "otlp");
      assert.equal(appEnvironment["OTEL_TRACES_EXPORTER"], "otlp");
      assert.equal(appEnvironment["OTEL_TRACES_SAMPLER"], undefined);
    }
  }

  const canaryFunction = await awsJson<{
    Configuration?: {
      FunctionArn?: string;
      Role?: string;
      VpcConfig?: { SubnetIds?: string[] };
      Environment?: { Variables?: Record<string, string> };
    };
  }>(["lambda", "get-function", "--function-name", metadata.canary.functionArn], environment.region);
  assert.equal(canaryFunction.Configuration?.FunctionArn, metadata.canary.functionArn);
  const canaryText = JSON.stringify(canaryFunction);
  for (const forbidden of ["ROUTE_TABLE_NAME", "BRIGHT_DATA", "PROXIDIZE", "CONTROL_API_TOKEN", "HEALTH_AGGREGATOR_URL"]) {
    assert.ok(!canaryText.includes(forbidden), `canary Lambda configuration contains ${forbidden}`);
  }
  const canaryEnvironment = canaryFunction.Configuration?.Environment?.Variables ?? {};
  assert.equal(canaryEnvironment["GEOIP_DATABASE_PATH"], "./data/GeoLite2-City.mmdb");
  assert.match(canaryEnvironment["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "", /^http:\/\/CanaryTelemetryCollector\./);
  assert.equal(metadata.geoIpBundleConfigured, true);
  assert.equal(metadata.canary.geoIpPackaged, true);
  const canaryApi = await awsJson<{ ProtocolType?: string; ApiEndpoint?: string }>(
    ["apigatewayv2", "get-api", "--api-id", metadata.canary.apiId],
    environment.region,
  );
  assert.equal(canaryApi.ProtocolType, "HTTP");
  assert.equal(canaryApi.ApiEndpoint, metadata.publicCanary.replace(/\/$/, ""));

  const integrationTarget = metadata.integrationTarget;
  assert.ok(integrationTarget);
  const integrationFunction = await awsJson<{
    Configuration?: {
      FunctionArn?: string;
      Environment?: { Variables?: Record<string, string> };
    };
  }>(["lambda", "get-function", "--function-name", integrationTarget.functionArn], environment.region);
  assert.equal(integrationFunction.Configuration?.FunctionArn, integrationTarget.functionArn);
  const integrationEnvironment = integrationFunction.Configuration?.Environment?.Variables ?? {};
  assert.equal(integrationEnvironment["INTEGRATION_TARGET_TABLE_NAME"], integrationTarget.stateTable);
  for (const forbidden of ["ROUTE_TABLE_NAME", "BRIGHT_DATA", "PROXIDIZE", "CONTROL_API_TOKEN", "AXIOM_TOKEN"]) {
    assert.ok(!JSON.stringify(integrationEnvironment).includes(forbidden));
  }
  const targetConcurrency = await awsJson<{ ReservedConcurrentExecutions?: number }>(
    ["lambda", "get-function-concurrency", "--function-name", integrationTarget.functionArn],
    environment.region,
  );
  assert.equal(targetConcurrency.ReservedConcurrentExecutions, 5);
  const targetApi = await awsJson<{ ProtocolType?: string; ApiEndpoint?: string }>(
    ["apigatewayv2", "get-api", "--api-id", integrationTarget.apiId],
    environment.region,
  );
  assert.equal(targetApi.ProtocolType, "HTTP");
  assert.equal(targetApi.ApiEndpoint, integrationTarget.url.replace(/\/$/, ""));

  const productCollector = await describeTaskDefinition(metadata.services.telemetry.taskDefinition, environment.region);
  const productCollectorEnvironment = environmentOf(productCollector.containerDefinitions?.[0]);
  assert.match(productCollectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /otlp_http\/passive_health/);
  assert.match(productCollectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /profound\.proxy\.passive_health/);
  const canaryCollector = await describeTaskDefinition(metadata.services.canaryTelemetry.taskDefinition, environment.region);
  const canaryCollectorEnvironment = environmentOf(canaryCollector.containerDefinitions?.[0]);
  assert.match(canaryCollectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /axiom_security_logs/);
  assert.match(canaryCollectorEnvironment["AOT_CONFIG_CONTENT"] ?? "", /filter\/security|filter\/operational/);
});

deployedTest("deployed networks isolate the canary and keep status and aggregation private", async () => {
  const environment = await deployedEnvironment();
  const metadata = environment.metadata;
  const vpcs = await awsJson<{ Vpcs?: Array<{ VpcId?: string; State?: string }> }>(
    ["ec2", "describe-vpcs", "--vpc-ids", metadata.productVpcId, metadata.canaryVpcId],
    environment.region,
  );
  assert.deepEqual(new Set(vpcs.Vpcs?.map(({ VpcId }) => VpcId)), new Set([metadata.productVpcId, metadata.canaryVpcId]));
  assert.ok(vpcs.Vpcs?.every(({ State }) => State === "available"));

  for (const [name, serviceMetadata] of Object.entries(metadata.services)) {
    const service = await describeService(serviceMetadata.cluster, serviceMetadata.service, environment.region);
    const subnetIds = service.networkConfiguration?.awsvpcConfiguration?.subnets ?? [];
    assert.ok(subnetIds.length > 0);
    const subnets = await awsJson<{ Subnets?: Array<{ VpcId?: string }> }>(
      ["ec2", "describe-subnets", "--subnet-ids", ...subnetIds],
      environment.region,
    );
    const expectedVpc = name === "canaryTelemetry" ? metadata.canaryVpcId : metadata.productVpcId;
    assert.ok(subnets.Subnets?.every(({ VpcId }) => VpcId === expectedVpc));
  }

  const canaryFunction = await awsJson<{ VpcConfig?: { SubnetIds?: string[] } }>(
    ["lambda", "get-function-configuration", "--function-name", metadata.canary.functionArn],
    environment.region,
  );
  const canarySubnetIds = canaryFunction.VpcConfig?.SubnetIds ?? [];
  assert.ok(canarySubnetIds.length > 0);
  const canarySubnets = await awsJson<{ Subnets?: Array<{ VpcId?: string }> }>(
    ["ec2", "describe-subnets", "--subnet-ids", ...canarySubnetIds],
    environment.region,
  );
  assert.ok(canarySubnets.Subnets?.every(({ VpcId }) => VpcId === metadata.canaryVpcId));

  const integrationTarget = metadata.integrationTarget;
  assert.ok(integrationTarget);
  const targetFunction = await awsJson<{ VpcConfig?: { SubnetIds?: string[] } }>(
    ["lambda", "get-function-configuration", "--function-name", integrationTarget.functionArn],
    environment.region,
  );
  const targetSubnetIds = targetFunction.VpcConfig?.SubnetIds ?? [];
  assert.deepEqual(targetSubnetIds, []);

  const transportTarget = metadata.integrationTransportTarget;
  assert.equal(transportTarget !== null, environment.stage === "ci" || environment.stage.startsWith("ci-"));
  if (transportTarget !== null) {
    const transportService = await describeService(transportTarget.cluster, transportTarget.service, environment.region);
    assert.equal(transportService.status, "ACTIVE");
    assert.equal(transportService.runningCount, 1);
    assert.deepEqual(await loadBalancerSchemes(transportService, environment.region), ["internet-facing"]);
    const transportSubnetIds = transportService.networkConfiguration?.awsvpcConfiguration?.subnets ?? [];
    const transportSubnets = await awsJson<{ Subnets?: Array<{ VpcId?: string }> }>(
      ["ec2", "describe-subnets", "--subnet-ids", ...transportSubnetIds],
      environment.region,
    );
    assert.ok(transportSubnets.Subnets?.every(({ VpcId }) => VpcId === metadata.canaryVpcId));
  }

  assert.ok(
    (
      await loadBalancerSchemes(
        await describeService(metadata.services.proxy.cluster, metadata.services.proxy.service, environment.region),
        environment.region,
      )
    ).every((scheme) => scheme === "internal"),
  );
  assert.equal(metadata.proxyTransport.scheme, "internal");
  assert.ok(
    (
      await loadBalancerSchemes(
        await describeService(metadata.services.healthAggregator.cluster, metadata.services.healthAggregator.service, environment.region),
        environment.region,
      )
    ).every((scheme) => scheme === "internal"),
  );
  assert.ok(
    (
      await loadBalancerSchemes(
        await describeService(metadata.services.status.cluster, metadata.services.status.service, environment.region),
        environment.region,
      )
    ).every((scheme) => scheme === "internal"),
  );
  assert.ok(
    (
      await loadBalancerSchemes(
        await describeService(metadata.services.controlPlane.cluster, metadata.services.controlPlane.service, environment.region),
        environment.region,
      )
    ).every((scheme) => scheme === "internal"),
  );
  assert.ok(
    (
      await loadBalancerSchemes(
        await describeService(metadata.services.notification.cluster, metadata.services.notification.service, environment.region),
        environment.region,
      )
    ).every((scheme) => scheme === "internal"),
  );

  const proxyService = await describeService(metadata.services.proxy.cluster, metadata.services.proxy.service, environment.region);
  const proxyTargetGroups = (proxyService.loadBalancers ?? []).flatMap(({ targetGroupArn }) =>
    targetGroupArn === undefined ? [] : [targetGroupArn],
  );
  assert.ok(proxyTargetGroups.length >= 2);
  const targetGroups = await awsJson<{ TargetGroups?: Array<{ LoadBalancerArns?: string[] }> }>(
    ["elbv2", "describe-target-groups", "--target-group-arns", ...proxyTargetGroups],
    environment.region,
  );
  const proxyLoadBalancers = [...new Set((targetGroups.TargetGroups ?? []).flatMap(({ LoadBalancerArns }) => LoadBalancerArns ?? []))];
  assert.equal(proxyLoadBalancers.length, 1);
  const proxyLoadBalancer = proxyLoadBalancers[0];
  assert.ok(proxyLoadBalancer);
  const listeners = await awsJson<{ Listeners?: Array<{ ListenerArn?: string; Port?: number; Protocol?: string }> }>(
    ["elbv2", "describe-listeners", "--load-balancer-arn", proxyLoadBalancer],
    environment.region,
  );
  assert.equal(listeners.Listeners?.length, 2);
  for (const listener of listeners.Listeners ?? []) {
    assert.ok(listener.ListenerArn);
    if (listener.Protocol === "TLS") {
      assert.equal(listener.Port, 8080);
      assert.equal(metadata.proxyTransport.httpListenerIdleTimeoutSeconds, 350);
      continue;
    }
    assert.equal(listener.Protocol, "TCP");
    const listenerArn = listener.ListenerArn;
    assert.ok(listenerArn);
    const listenerAttributes = await awsJson<{ Attributes?: Array<{ Key?: string; Value?: string }> }>(
      ["elbv2", "describe-listener-attributes", "--listener-arn", listenerArn],
      environment.region,
    );
    const values = Object.fromEntries(
      (listenerAttributes.Attributes ?? []).flatMap(({ Key, Value }) => (Key === undefined || Value === undefined ? [] : [[Key, Value]])),
    );
    const expected =
      listener.Port === 1080
        ? metadata.proxyTransport.socks5ListenerIdleTimeoutSeconds
        : metadata.proxyTransport.httpListenerIdleTimeoutSeconds;
    assert.equal(values["tcp.idle_timeout.seconds"], String(expected));
  }
  for (const targetGroupArn of proxyTargetGroups) {
    const targetAttributes = await awsJson<{ Attributes?: Array<{ Key?: string; Value?: string }> }>(
      ["elbv2", "describe-target-group-attributes", "--target-group-arn", targetGroupArn],
      environment.region,
    );
    const values = Object.fromEntries(
      (targetAttributes.Attributes ?? []).flatMap(({ Key, Value }) => (Key === undefined || Value === undefined ? [] : [[Key, Value]])),
    );
    assert.equal(values["deregistration_delay.timeout_seconds"], String(metadata.proxyTransport.deregistrationDelaySeconds));
    assert.equal(values["deregistration_delay.connection_termination.enabled"], "false");
  }
});

deployedTest("deployed DynamoDB and Axiom datasets preserve durable state and retention", async () => {
  const environment = await deployedEnvironment();
  const expectedTelemetryRetention = 30;
  assert.equal(environment.metadata.telemetry.retentionDays, expectedTelemetryRetention);
  const table = await awsJson<{
    Table?: {
      TableStatus?: string;
      BillingModeSummary?: { BillingMode?: string };
      GlobalSecondaryIndexes?: Array<{ IndexName?: string; IndexStatus?: string }>;
      DeletionProtectionEnabled?: boolean;
    };
  }>(["dynamodb", "describe-table", "--table-name", environment.metadata.routeTable], environment.region);
  assert.equal(table.Table?.TableStatus, "ACTIVE");
  assert.equal(table.Table?.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");
  assert.deepEqual(table.Table?.GlobalSecondaryIndexes?.map(({ IndexName }) => IndexName).sort(), [
    "EndpointAssignments",
    "EntityCreatedAt",
  ]);
  assert.ok(table.Table?.GlobalSecondaryIndexes?.every(({ IndexStatus }) => IndexStatus === "ACTIVE"));

  const backups = await awsJson<{
    ContinuousBackupsDescription?: {
      PointInTimeRecoveryDescription?: { PointInTimeRecoveryStatus?: string };
    };
  }>(["dynamodb", "describe-continuous-backups", "--table-name", environment.metadata.routeTable], environment.region);
  assert.equal(backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, "ENABLED");

  const integrationTarget = environment.metadata.integrationTarget;
  assert.ok(integrationTarget);
  const targetTable = await awsJson<{
    Table?: {
      TableStatus?: string;
      BillingModeSummary?: { BillingMode?: string };
      DeletionProtectionEnabled?: boolean;
    };
  }>(["dynamodb", "describe-table", "--table-name", integrationTarget.stateTable], environment.region);
  assert.equal(targetTable.Table?.TableStatus, "ACTIVE");
  assert.equal(targetTable.Table?.BillingModeSummary?.BillingMode, "PAY_PER_REQUEST");
  assert.equal(targetTable.Table?.DeletionProtectionEnabled, false);
  const targetTtl = await awsJson<{
    TimeToLiveDescription?: {
      TimeToLiveStatus?: string;
      AttributeName?: string;
    };
  }>(["dynamodb", "describe-time-to-live", "--table-name", integrationTarget.stateTable], environment.region);
  assert.match(targetTtl.TimeToLiveDescription?.TimeToLiveStatus ?? "", /^ENABL(?:ING|ED)$/);
  assert.equal(targetTtl.TimeToLiveDescription?.AttributeName, "expiresAt");

  const expectedDatasets = [
    [environment.metadata.telemetry.datasets.logs, "axiom:events:v1", expectedTelemetryRetention],
    [environment.metadata.telemetry.datasets.traces, "axiom:events:v1", expectedTelemetryRetention],
    [environment.metadata.telemetry.datasets.metrics, "otel:metrics:v1", expectedTelemetryRetention],
  ] as const;
  for (const [name, kind, retentionDays] of expectedDatasets) {
    const dataset = await axiomJson<{ name?: string; kind?: string; retentionDays?: number }>(`v2/datasets/${encodeURIComponent(name)}`);
    assert.equal(dataset.name, name);
    assert.equal(dataset.kind, kind);
    assert.equal(dataset.retentionDays, retentionDays);
  }
});

deployedTest("deployed access-grant credentials and route requirements survive an ECS replacement", async (t) => {
  if (process.env["DEPLOYED_RUN_DISRUPTIVE_TESTS"] !== "1") {
    t.skip("set DEPLOYED_RUN_DISRUPTIVE_TESTS=1 to replace the proxy ECS task");
    return;
  }
  const environment = await deployedEnvironment();
  assert.ok(environment.metadata.integrationTarget);
  const proxyService = environment.metadata.services.proxy;
  const route = await createRoute({
    name: `restart-persistence-${Date.now()}`,
    targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
    rotation: { mode: "manual" },
    isAuthenticated: true,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.profile.id).catch(() => undefined));
  const target = new URL("/restart", environment.metadata.integrationTarget.url).toString();
  const before = await requestViaHttpProxy(route.proxyUrls.http, target);
  assert.equal(before.status, 200);
  const city = before.headers["x-mock-city"];

  const previousTasks = await awsJson<{ taskArns?: string[] }>(
    ["ecs", "list-tasks", "--cluster", proxyService.cluster, "--service-name", proxyService.service],
    environment.region,
  );
  await awsJson(
    ["ecs", "update-service", "--cluster", proxyService.cluster, "--service", proxyService.service, "--force-new-deployment"],
    environment.region,
  );

  await waitFor(
    "proxy ECS replacement to stabilize",
    async () => {
      const service = await describeService(proxyService.cluster, proxyService.service, environment.region);
      if (service.deployments?.length !== 1 || service.runningCount !== service.desiredCount) return undefined;
      const current = await awsJson<{ taskArns?: string[] }>(
        ["ecs", "list-tasks", "--cluster", proxyService.cluster, "--service-name", proxyService.service],
        environment.region,
      );
      return current.taskArns?.some((arn) => !(previousTasks.taskArns ?? []).includes(arn)) ? current : undefined;
    },
    { timeoutMs: 15 * 60_000, intervalMs: 10_000 },
  );

  const after = await waitFor(
    "route to work after ECS replacement",
    async () => {
      try {
        const response = await requestViaHttpProxy(route.proxyUrls.http, target);
        return response.status === 200 ? response : undefined;
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 120_000, intervalMs: 3_000 },
  );
  assert.equal(after.headers["x-mock-city"], city);
});
