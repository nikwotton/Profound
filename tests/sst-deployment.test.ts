import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("SST isolates AWS resources behind a provider-selected deployment module", () => {
  const root = readFileSync("sst.config.ts", "utf8");
  const aws = readFileSync("infra/providers/aws.ts", "utf8");

  assert.match(root, /DEPLOYMENT_PROVIDER/);
  assert.match(root, /infra\/providers\/aws\.js/);
  assert.match(root, /import\("\.\/infra\/providers\/aws\.js"\)/);
  assert.match(root, /awsDeployment\.(app|run)/);
  assert.doesNotMatch(root, /sst\.aws\.|new aws\./);

  assert.match(aws, /new sst\.Secret\("AxiomIngestToken"\)/);
  assert.match(aws, /schemaVersion: 2/);
  assert.match(aws, /new sst\.Secret\("ControlApiIdentities"\)/);
  assert.match(aws, /CONTROL_API_IDENTITIES_JSON: controlIdentitiesSecret/);
  assert.match(aws, /new sst\.aws\.Service\("ProxyRouter"/);
  assert.match(aws, /new sst\.aws\.Service\("ControlPlane"/);
  assert.match(aws, /new sst\.aws\.Service\("HealthAggregator"/);
  assert.match(aws, /new sst\.aws\.Service\("StatusApplication"/);
  assert.match(aws, /new sst\.aws\.Service\("NotificationService"/);
  assert.match(aws, /new sst\.aws\.Service\("TelemetryCollector"/);
  assert.match(aws, /new sst\.aws\.Service\("CanaryTelemetryCollector"/);
  assert.match(aws, /new sst\.aws\.ApiGatewayV2\("PublicCanary"/);
  assert.match(aws, /handler: "src\/canary-lambda\.handler"/);
  assert.doesNotMatch(aws, /new sst\.aws\.Service\("PublicCanary"/);
  assert.match(aws, /const service = new sst\.aws\.Service\("ProxyRouter"[\s\S]*?loadBalancer:\s*{\s*public: false,/);
  assert.match(aws, /if \(args\.protocol === "TCP"\) \{\s*args\.tcpIdleTimeoutSeconds = nlbTcpIdleTimeoutSeconds;/);
  assert.match(aws, /httpListenerIdleTimeoutSeconds: tlsEnabled \? 350 : nlbTcpIdleTimeoutSeconds/);
  assert.match(aws, /socks5ListenerIdleTimeoutSeconds: nlbTcpIdleTimeoutSeconds/);
  assert.match(aws, /deregistrationDelay = nlbDeregistrationDelaySeconds/);
  assert.match(aws, /connectionTermination = false/);
  assert.match(aws, /GEOIP_DATABASE_SOURCE/);
  assert.match(aws, /copyFiles: geoIpBundleConfigured/);
  assert.match(aws, /otlp_http\/axiom_logs/);
  assert.match(aws, /otlp_http\/axiom_traces/);
  assert.match(aws, /otlp_http\/axiom_metrics/);
  assert.match(aws, /x-axiom-dataset/);
  assert.match(aws, /x-axiom-metrics-dataset/);
  assert.match(aws, /sending_queue/);
  assert.match(aws, /retry_on_failure/);
  assert.match(aws, /logs\/operational/);
  assert.match(aws, /logs\/security/);
  assert.match(aws, /log\.category/);
  assert.ok(
    aws.split("x-axiom-dataset: \\${env:AXIOM_LOGS_DATASET}").length - 1 >= 3,
    "operational, security, and general log exporters must share the log dataset",
  );
  assert.doesNotMatch(aws, /AXIOM_SECURITY_LOGS_DATASET|SECURITY_LOG_RETENTION_DAYS/);
  assert.match(aws, /endpoint: 0\.0\.0\.0:4318/);
  assert.doesNotMatch(aws, /sigv4auth|x-aws-log-group|monitoring\.\$\{region\}\.amazonaws\.com/);
});
