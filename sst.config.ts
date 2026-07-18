/// <reference path="./.sst/platform/config.d.ts" />

// AWS is the only v0 deployment target. Provider-specific resources stay
// behind a module so a future target can replace this deliberately.
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
