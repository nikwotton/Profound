export const v0Policy = {
  loadBalancer: {
    tcpIdleTimeoutSeconds: 1_200,
    deregistrationDelaySeconds: 300,
  },
  routing: {
    allowedTargetPorts: "80,443",
    connectTimeoutMs: "10000",
    operationTimeoutMs: "30000",
    retryMaxAttempts: "4",
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
