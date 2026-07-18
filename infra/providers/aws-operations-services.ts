/// <reference path="../../.sst/platform/config.d.ts" />

import { v0Policy } from "./aws-policy.js";
import { containerHttpHealth, privateHttpLoadBalancer } from "./aws-service-config.js";
import type { containerSecret } from "./aws-secrets.js";

type Cluster = InstanceType<typeof sst.aws.Cluster>;
type RouteTable = InstanceType<typeof sst.aws.Dynamo>;
type CanaryApi = InstanceType<typeof sst.aws.ApiGatewayV2>;
type SecretReference = ReturnType<typeof containerSecret>;
type Interpolated = ReturnType<typeof $interpolate>;
type ServiceImage =
  string | { readonly context: string; readonly dockerfile: string; readonly args: { readonly INCLUDE_DEV_TOOLS: string } };
type OtelEnvironment = (
  serviceName: string,
  endpoint: string | Interpolated,
  cloudPlatform?: string,
) => Record<string, string | Interpolated>;

export function createOperationsServices(options: {
  cluster: Cluster;
  production: boolean;
  routeState: RouteTable;
  applicationImage: ServiceImage;
  providerMode: string;
  healthAggregatorToken: SecretReference;
  canarySigningSecret: SecretReference;
  providerSecrets?: Record<string, SecretReference>;
  syntheticRouteSecrets?: Record<string, SecretReference>;
  canaryApi: CanaryApi;
  tlsEnabled: boolean;
  host: string | Interpolated;
  proxidizeExactCitySupport: string;
  telemetryCollectorEndpoint: Interpolated;
  otelEnvironment: OtelEnvironment;
  devHealthAggregatorToken: string;
  devCanarySigningSecret: string;
  usageAccountingSourceToken?: SecretReference;
  alertDestinationSecret?: SecretReference;
}) {
  const {
    cluster,
    production,
    routeState,
    applicationImage,
    providerMode,
    healthAggregatorToken,
    canarySigningSecret,
    providerSecrets,
    syntheticRouteSecrets,
    canaryApi,
    tlsEnabled,
    host,
    proxidizeExactCitySupport,
    telemetryCollectorEndpoint,
    otelEnvironment,
    devHealthAggregatorToken,
    devCanarySigningSecret,
    usageAccountingSourceToken,
    alertDestinationSecret,
  } = options;

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
        dev: { command: "pnpm internal:dev:service" },
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
        dev: { command: "pnpm internal:dev:service" },
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
        dev: { command: "pnpm internal:dev:service" },
        environment: {
          NODE_ENV: "production",
          SERVICE_MODE: "usage-accounting",
          ROUTE_TABLE_NAME: routeState.name,
          USAGE_ACCOUNTING_HOST: $dev ? "127.0.0.1" : "0.0.0.0",
          USAGE_ACCOUNTING_PORT: "8085",
          USAGE_ACCOUNTING_INTERVAL_MS: v0Policy.usageAccounting.intervalMs,
          PROVIDER_COST_TOTALS_JSON: v0Policy.usageAccounting.providerCostTotalsJson,
          PROVISIONED_PROXY_SLOT_CAPACITY_JSON: v0Policy.usageAccounting.provisionedProxySlotCapacityJson,
          ...(v0Policy.usageAccounting.sourceUrl === undefined ? {} : { USAGE_ACCOUNTING_SOURCE_URL: v0Policy.usageAccounting.sourceUrl }),
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
        dev: { command: "pnpm internal:dev:service" },
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

  return { healthAggregator, status, usageAccounting, notification };
}
