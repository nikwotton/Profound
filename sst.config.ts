/// <reference path="./.sst/platform/config.d.ts" />

const deploymentProvider = process.env.DEPLOYMENT_PROVIDER ?? "aws";

if (deploymentProvider !== "aws") {
  throw new Error(`Unsupported DEPLOYMENT_PROVIDER: ${deploymentProvider}`);
}

// The root config selects a deployment provider. Provider-specific resources
// stay behind modules so adding another cloud does not change the service or
// telemetry contracts.
export default $config({
  async app(input) {
    const { awsDeployment } = await import("./infra/providers/aws.js");
    return awsDeployment.app(input);
  },
  async run() {
    const { awsDeployment } = await import("./infra/providers/aws.js");
    return awsDeployment.run();
  },
});
