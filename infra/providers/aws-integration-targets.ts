/// <reference path="../../.sst/platform/config.d.ts" />

type Cluster = InstanceType<typeof sst.aws.Cluster>;
type ServiceImage =
  string | { readonly context: string; readonly dockerfile: string; readonly args: { readonly INCLUDE_DEV_TOOLS: string } };

export function createIntegrationTargets(options: {
  production: boolean;
  cloudTestStage: boolean;
  canaryCluster: Cluster;
  applicationImage: ServiceImage;
}) {
  const { production, cloudTestStage, canaryCluster, applicationImage } = options;

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

  return { integrationTargetState, integrationTargetApi, integrationTargetRoute, integrationTransportTarget };
}
