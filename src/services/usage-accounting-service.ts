import { createServer } from "node:http";
import { expectArray, expectRecord, parseJson } from "../decoding.js";
import type { Logger } from "../logger.js";
import { closeServer, listen } from "../net-utils.js";
import { ResourceScope } from "../resource-scope.js";
import {
  decodeProviderCostTotal,
  decodeProvisionedProxySlotCapacity,
  provisionedProxySlotCapacityRecord,
  UsageAccountingWorker,
  type UsageVarianceThresholds,
} from "../usage-accounting.js";
import {
  createStore,
  integer,
  nonnegativeNumber,
  persistenceConfig,
  type RunningService,
  type RuntimeServiceDependencies,
} from "./runtime.js";

function jsonArray<T>(value: string | undefined, name: string, decode: (value: unknown, context: string) => T): T[] {
  if (value?.trim() === undefined || value.trim() === "") return [];
  return expectArray(parseJson(value, name), name).map((item, index) => decode(item, `${name}[${index}]`));
}

export async function startUsageAccountingService(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RunningService> {
  const scope = new ResourceScope();
  try {
    const store = createStore(persistenceConfig(env), dependencies);
    scope.defer(() => store.close());

    let providerTotals = jsonArray(env["PROVIDER_COST_TOTALS_JSON"], "PROVIDER_COST_TOTALS_JSON", decodeProviderCostTotal);
    let capacity = jsonArray(
      env["PROVISIONED_PROXY_SLOT_CAPACITY_JSON"],
      "PROVISIONED_PROXY_SLOT_CAPACITY_JSON",
      decodeProvisionedProxySlotCapacity,
    );
    const sourceUrl = env["USAGE_ACCOUNTING_SOURCE_URL"]?.trim() || undefined;
    const thresholds: UsageVarianceThresholds = {
      absoluteFloorUsd: nonnegativeNumber(env["USAGE_VARIANCE_ABSOLUTE_FLOOR_USD"], 1, "USAGE_VARIANCE_ABSOLUTE_FLOOR_USD"),
      warningRelative: nonnegativeNumber(env["USAGE_VARIANCE_WARNING_RELATIVE"], 0.05, "USAGE_VARIANCE_WARNING_RELATIVE"),
      errorRelative: nonnegativeNumber(env["USAGE_VARIANCE_ERROR_RELATIVE"], 0.15, "USAGE_VARIANCE_ERROR_RELATIVE"),
    };
    const worker = new UsageAccountingWorker(
      store,
      () => providerTotals,
      thresholds,
      (record) => {
        const attributes = {
          "event.name": "profound.usage.reconciliation_variance",
          provider: record.provider,
          periodStartedAt: record.periodStartedAt,
          periodEndsAt: record.periodEndsAt,
          estimatedTotalUsd: record.estimatedTotalUsd,
          reportedTotalUsd: record.reportedTotalUsd,
          adjustmentUsd: record.adjustmentUsd,
          relativeVariance: record.relativeVariance,
          varianceAttribution: record.varianceAttribution,
          severity: record.severity,
        };
        if (record.severity === "error") logger.error("Usage reconciliation variance is severe or repeated", attributes);
        else if (record.severity === "warning") logger.warn("Usage reconciliation variance exceeded a warning threshold", attributes);
        else logger.info("Usage reconciliation completed", attributes);
      },
      (rollup, provider) => {
        const attributes = {
          "event.name": "profound.usage.capacity_recommendation",
          provider,
          periodStartedAt: rollup.periodStartedAt,
          periodEndsAt: rollup.periodEndsAt,
          provisionedSlots: rollup.provisionedSlots,
          peakConcurrentConnections: rollup.peakConcurrentConnections,
          p95ConcurrentConnections: rollup.p95ConcurrentConnections,
          concurrencyUtilization: rollup.concurrencyUtilization,
          throughputUtilization: rollup.throughputUtilization,
          capacityDrivenFallbackCount: rollup.capacityDrivenFallbackCount,
          capacityFailureCount: rollup.capacityFailureCount,
          capacityWaitMs: rollup.capacityWaitMs,
          capacityConstraint: rollup.capacityConstraint,
          capacityPolicyVersion: rollup.capacityPolicyVersion,
        };
        if (rollup.capacityFailureCount > 0) logger.error("Proxy-slot capacity recommendation includes observed failures", attributes);
        else logger.warn("Proxy-slot capacity recommendation created from pressure evidence", attributes);
      },
    );
    const intervalMs = integer(env["USAGE_ACCOUNTING_INTERVAL_MS"], 60_000, "USAGE_ACCOUNTING_INTERVAL_MS", 1_000);
    let lastError: string | undefined;
    let running = false;
    const run = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        if (sourceUrl !== undefined) {
          const response = await (dependencies.fetchImplementation ?? fetch)(sourceUrl, {
            headers: env["USAGE_ACCOUNTING_SOURCE_TOKEN"]?.trim()
              ? { authorization: `Bearer ${env["USAGE_ACCOUNTING_SOURCE_TOKEN"].trim()}` }
              : {},
            signal: AbortSignal.timeout(integer(env["USAGE_ACCOUNTING_SOURCE_TIMEOUT_MS"], 10_000, "USAGE_ACCOUNTING_SOURCE_TIMEOUT_MS")),
          });
          if (!response.ok) throw new Error(`usage_accounting_source_${response.status}`);
          const published = expectRecord(await response.json(), "usage-accounting source response");
          if (published["providerTotals"] !== undefined) {
            providerTotals = expectArray(published["providerTotals"], "usage-accounting source response.providerTotals").map(
              (item, index) => decodeProviderCostTotal(item, `usage-accounting source response.providerTotals[${index}]`),
            );
          }
          if (published["provisionedProxySlotCapacity"] !== undefined) {
            capacity = expectArray(
              published["provisionedProxySlotCapacity"],
              "usage-accounting source response.provisionedProxySlotCapacity",
            ).map((item, index) =>
              decodeProvisionedProxySlotCapacity(item, `usage-accounting source response.provisionedProxySlotCapacity[${index}]`),
            );
          }
        }
        for (const item of capacity) await store.recordUsage(provisionedProxySlotCapacityRecord(item));
        const to = new Date().toISOString();
        const from = new Date(Date.now() - 32 * 86_400_000).toISOString();
        const rollupCount = await worker.run(from, to);
        lastError = undefined;
        logger.info("Usage accounting rollups completed", {
          rollupCount,
          costTotals: providerTotals.length,
          provisionedProxySlots: capacity.length,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : "unknown";
        logger.error("Usage accounting rollups failed", { error: lastError });
      } finally {
        running = false;
      }
    };
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health/live") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "live" }));
        return;
      }
      if (request.method === "GET" && request.url === "/health/ready") {
        response.writeHead(lastError === undefined ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify(lastError === undefined ? { status: "ready" } : { status: "failed" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    const address = await listen(
      server,
      env["USAGE_ACCOUNTING_HOST"] ?? "127.0.0.1",
      integer(env["USAGE_ACCOUNTING_PORT"], 8085, "USAGE_ACCOUNTING_PORT", 0),
    );
    scope.defer(() => closeServer(server));
    await run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref();
    scope.defer(() => clearInterval(timer));
    logger.info("Usage accounting service started", { address });
    return scope.service();
  } catch (error) {
    await scope.close().catch(() => undefined);
    throw error;
  }
}
