/// <reference path="../../.sst/platform/config.d.ts" />

import { canaryCollectorConfig, proxyCollectorConfig } from "./aws-telemetry-config.js";
import type { containerSecret } from "./aws-secrets.js";

type Cluster = InstanceType<typeof sst.aws.Cluster>;
type SecretReference = ReturnType<typeof containerSecret>;
type Interpolated = ReturnType<typeof $interpolate>;

export function createTelemetryCollectorServices(options: {
  cluster: Cluster;
  canaryCluster: Cluster;
  production: boolean;
  adotImage: string;
  axiomCollectorEnvironment: Record<string, string>;
  axiomToken: SecretReference;
  healthAggregatorToken: SecretReference;
  healthAggregatorPassiveEndpoint: Interpolated;
}) {
  const {
    cluster,
    canaryCluster,
    production,
    adotImage,
    axiomCollectorEnvironment,
    axiomToken,
    healthAggregatorToken,
    healthAggregatorPassiveEndpoint,
  } = options;

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
          AOT_CONFIG_CONTENT: proxyCollectorConfig(healthAggregatorPassiveEndpoint),
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

  return { telemetryCollector, canaryTelemetryCollector };
}
