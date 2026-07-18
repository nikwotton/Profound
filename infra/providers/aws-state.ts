/// <reference path="../../.sst/platform/config.d.ts" />

export function createStateResources(options: { production: boolean; developer: boolean; deploymentId: string }) {
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
    deletionProtection: options.production,
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
      DEPLOYMENT_ID: options.deploymentId,
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
    enabled: !options.developer,
    function: deploymentCoordinator,
  });
  return { routeState, deploymentNotifications, deploymentCoordinator };
}
