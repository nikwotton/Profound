import { TRANSPORT_POLICY, V0_POLICY } from "../../src/service-policies.js";

export const v0Policy = {
  loadBalancer: {
    tcpIdleTimeoutSeconds: 1_200,
    deregistrationDelaySeconds: 300,
  },
  routing: {
    allowedTargetPorts: TRANSPORT_POLICY.allowedTargetPorts.join(","),
    blockedTargetHostnames: TRANSPORT_POLICY.blockedTargetHostnames.join(","),
    streamBufferBytes: String(TRANSPORT_POLICY.streamBufferBytes),
    maxHeaderBytes: String(TRANSPORT_POLICY.maxHeaderBytes),
    targetActiveConnectionsPerTask: TRANSPORT_POLICY.targetActiveConnectionsPerTask,
    connectTimeoutMs: String(V0_POLICY.establishmentBudget.attemptTimeoutMs),
    operationTimeoutMs: String(V0_POLICY.establishmentBudget.operationTimeoutMs),
    retryMaxAttempts: String(V0_POLICY.establishmentBudget.providersPerOperation * V0_POLICY.establishmentBudget.candidatesPerProvider),
  },
  telemetry: {
    axiomEndpoint: "https://api.axiom.co",
    retentionDays: 30,
  },
  canary: {
    requestsPerMinute: "60",
    throttleBurst: 30,
    throttleRate: 10,
    geoIpDatabaseSource: ".sst/geoip/GeoLite2-City.mmdb",
    geoIpMaxAccuracyRadiusKm: "100",
  },
  health: {
    providerRefreshMs: "60000",
    passiveMaxAgeMs: "300000",
    syntheticCooldownMs: "300000",
    alertDegradedDelayMs: "300000",
    alertWebhookTimeoutMs: "5000",
    alertWebhookMaxAttempts: "5",
    alertWebhookInitialBackoffMs: "1000",
    alertDestinationIds: "",
    alertConfigurationVersion: "unconfigured",
    statusStaleAfterMs: "300000",
  },
  usageAccounting: {
    intervalMs: "60000",
    providerCostTotalsJson: "[]",
    provisionedProxySlotCapacityJson: "[]",
    sourceUrl: undefined as string | undefined,
    sourceTimeoutMs: "10000",
    varianceAbsoluteFloorUsd: "1",
    varianceWarningRelative: "0.05",
    varianceErrorRelative: "0.15",
  },
  notification: {
    pollIntervalMs: "5000",
  },
} as const;
