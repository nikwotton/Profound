/// <reference path="../../.sst/platform/config.d.ts" />

type Duration = `${number} second` | `${number} seconds` | `${number} minute` | `${number} minutes`;
type Vpc = InstanceType<typeof sst.aws.Vpc>;

export function containerHttpHealth(port: number, path: string, startPeriod: Duration = "20 seconds") {
  return {
    command: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
    startPeriod,
    interval: "30 seconds" as const,
    timeout: "5 seconds" as const,
    retries: 3,
  };
}

export function createPrivateHttpIngress(
  name: string,
  options: {
    vpc: Vpc;
    port: number;
    healthPath: string;
    domain?: string;
    certificateArn?: string;
    allowedCidrs?: string[];
  },
) {
  const { vpc, port, healthPath, domain, certificateArn, allowedCidrs = ["0.0.0.0/0"] } = options;
  const listenerPort = domain === undefined ? 80 : 443;
  const listenerProtocol = domain === undefined ? "http" : "https";
  const alb = new sst.aws.Alb(`${name}Ingress`, {
    vpc,
    public: false,
    ...(domain === undefined
      ? {}
      : {
          domain: certificateArn === undefined ? domain : { name: domain, dns: false as const, cert: certificateArn },
        }),
    listeners: [{ port: listenerPort, protocol: listenerProtocol }],
    transform: {
      securityGroup(args) {
        args.ingress = allowedCidrs.map((cidrBlock) => ({
          protocol: "tcp",
          fromPort: listenerPort,
          toPort: listenerPort,
          cidrBlocks: [cidrBlock],
        }));
      },
    },
  });
  const target = new aws.lb.TargetGroup(`${name}IngressTarget`, {
    namePrefix: "http",
    port,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpc.id,
    healthCheck: {
      enabled: true,
      protocol: "HTTP",
      path: healthPath,
      interval: 30,
      timeout: 5,
      healthyThreshold: 5,
      unhealthyThreshold: 2,
      matcher: "200",
    },
  });
  const rule = new aws.lb.ListenerRule(`${name}IngressRule`, {
    listenerArn: alb.getListener(listenerProtocol, listenerPort).arn,
    priority: 1,
    actions: [{ type: "forward", targetGroupArn: target.arn }],
    conditions: [{ pathPattern: { values: ["/*"] } }],
  });

  return {
    url: alb.url,
    attach: (args: aws.ecs.ServiceArgs, opts: $util.CustomResourceOptions) => {
      args.loadBalancers = [{ targetGroupArn: target.arn, containerName: "app", containerPort: port }];
      args.healthCheckGracePeriodSeconds = 60;
      opts.dependsOn = rule;
      return undefined;
    },
  };
}
