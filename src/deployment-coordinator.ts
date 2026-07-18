import { DynamoRouteStore } from "./dynamo-store.js";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DEPLOYMENT_POLL_INTERVAL_MS, evaluateDeploymentDrain } from "./release-policy.js";
import type { RouteStore } from "./store.js";
import type { ActiveTunnel, DeploymentDrainState } from "./types.js";

export interface DeploymentDrainNotification {
  action: "notify" | "escalate" | "terminate";
  deploymentId: string;
  ageMs: number;
  activeTunnelCount: number;
  routeIds: string[];
  accessGrantIds: string[];
}

export interface DeploymentDrainResult {
  complete: boolean;
  activeTunnelCount: number;
  retryAfterMs: number;
}

export async function coordinateDeploymentDrain(
  store: Pick<RouteStore, "listAllActiveTunnels" | "getDeploymentDrain" | "saveDeploymentDrain">,
  currentDeploymentId: string,
  now: string,
  notify: (notification: DeploymentDrainNotification) => Promise<void>,
): Promise<DeploymentDrainResult> {
  const active = (await store.listAllActiveTunnels(now)).filter((tunnel) => tunnel.deploymentId !== currentDeploymentId);
  if (active.length === 0) return { complete: true, activeTunnelCount: 0, retryAfterMs: 0 };
  const byDeployment = new Map<string, ActiveTunnel[]>();
  for (const tunnel of active) {
    const tunnels = byDeployment.get(tunnel.deploymentId) ?? [];
    tunnels.push(tunnel);
    byDeployment.set(tunnel.deploymentId, tunnels);
  }
  for (const [deploymentId, tunnels] of byDeployment) {
    const existing = await store.getDeploymentDrain(deploymentId);
    const earliestTunnel = tunnels.map((tunnel) => tunnel.startedAt).sort()[0];
    if (earliestTunnel === undefined) throw new Error(`Deployment ${deploymentId} has no active tunnels`);
    const startedAt = existing?.startedAt ?? earliestTunnel;
    const evaluation = evaluateDeploymentDrain({
      startedAt,
      now,
      activeTunnelCount: tunnels.length,
      ...(existing?.lastNotificationAt === undefined ? {} : { lastNotificationAt: existing.lastNotificationAt }),
      ...(existing?.extensionUntil === undefined ? {} : { extensionUntil: existing.extensionUntil }),
    });
    const notificationAction =
      evaluation.action === "notify" || evaluation.action === "escalate" || evaluation.action === "terminate"
        ? evaluation.action
        : undefined;
    const state: DeploymentDrainState = {
      deploymentId,
      startedAt,
      terminateRemaining: existing?.terminateRemaining === true || evaluation.action === "terminate",
      ...(notificationAction === undefined
        ? existing?.lastNotificationAt === undefined
          ? {}
          : { lastNotificationAt: existing.lastNotificationAt }
        : { lastNotificationAt: now }),
      ...(existing?.extensionUntil === undefined ? {} : { extensionUntil: existing.extensionUntil }),
      updatedAt: now,
    };
    await store.saveDeploymentDrain(state);
    if (notificationAction !== undefined) {
      await notify({
        action: notificationAction,
        deploymentId,
        ageMs: evaluation.ageMs,
        activeTunnelCount: tunnels.length,
        routeIds: [...new Set(tunnels.map((tunnel) => tunnel.routeId))].sort(),
        accessGrantIds: [...new Set(tunnels.map((tunnel) => tunnel.accessGrantId))].sort(),
      });
    }
  }
  return { complete: false, activeTunnelCount: active.length, retryAfterMs: DEPLOYMENT_POLL_INTERVAL_MS };
}

interface EcsLifecycleHookResult {
  hookStatus: "SUCCEEDED" | "FAILED" | "IN_PROGRESS";
  callBackDelay?: number;
  hookDetails?: string;
}

export async function handler(): Promise<EcsLifecycleHookResult> {
  const tableName = process.env["ROUTE_TABLE_NAME"]?.trim();
  const currentDeploymentId = process.env["DEPLOYMENT_ID"]?.trim();
  const notificationTopicArn = process.env["DEPLOYMENT_NOTIFICATION_TOPIC_ARN"]?.trim();
  if (!tableName || !currentDeploymentId || !notificationTopicArn) {
    return { hookStatus: "FAILED", hookDetails: "ROUTE_TABLE_NAME, DEPLOYMENT_ID, and DEPLOYMENT_NOTIFICATION_TOPIC_ARN are required" };
  }
  const store = new DynamoRouteStore(tableName);
  const sns = new SNSClient({});
  try {
    const result = await coordinateDeploymentDrain(store, currentDeploymentId, new Date().toISOString(), async (notification) => {
      const message = JSON.stringify({ event: "deployment_drain", ...notification });
      process.stdout.write(`${message}\n`);
      await sns.send(
        new PublishCommand({
          TopicArn: notificationTopicArn,
          Subject: `Proxy deployment drain: ${notification.action}`,
          Message: message,
        }),
      );
    });
    if (result.complete) return { hookStatus: "SUCCEEDED", hookDetails: "No active tunnels remain on the retiring deployment" };
    return {
      hookStatus: "IN_PROGRESS",
      callBackDelay: Math.ceil(result.retryAfterMs / 1_000),
      hookDetails: `${result.activeTunnelCount} active tunnel(s) remain on retiring deployments`,
    };
  } catch (error) {
    return { hookStatus: "FAILED", hookDetails: error instanceof Error ? error.message : "Deployment drain failed" };
  } finally {
    await store.close();
    sns.destroy();
  }
}
