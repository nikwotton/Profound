import { expectInteger, expectIsoTimestamp, expectNonEmptyString, expectRecord } from "./decoding.js";
import { NotFoundError } from "./errors.js";
import { credentialUsername } from "./store.js";
import type {
  ActiveTunnel,
  CapacityCircuitState,
  DeploymentDrainState,
  ProviderId,
  ProviderInventorySnapshot,
  RouteStatus,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
} from "./domain/routing.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
} from "./domain/health.js";
import type { CapacityPressureEvidence, UsageAlertEvent, UsageReconciliation, UsageRecord, UsageRollup } from "./domain/usage.js";

export const ENTITY_INDEX = "EntityCreatedAt";
export const ASSIGNMENT_INDEX = "EndpointAssignments";
export const ACCESS_GRANT_LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;
export const HIGH_VOLUME_ENTITY_SHARDS = 16;

export function shardedEntity(entity: "active_tunnel" | "usage_record", id: string): string {
  let hash = 2_166_136_261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return `${entity}#${(hash >>> 0) % HIGH_VOLUME_ENTITY_SHARDS}`;
}

export function entityShards(entity: "active_tunnel" | "usage_record"): string[] {
  return Array.from({ length: HIGH_VOLUME_ENTITY_SHARDS }, (_, shard) => `${entity}#${shard}`);
}

export function itemField(item: unknown, field: string, context: string): unknown {
  return expectRecord(item, context)[field];
}

export interface RouteItem {
  pk: string;
  sk: string;
  entity: "route";
  createdAt: string;
  status: RouteStatus;
  route: StoredRoute;
  gsi1pk?: string;
  gsi1sk?: string;
}

export interface AccessGrantItem {
  pk: string;
  sk: "STATE";
  entity: "access_grant";
  createdAt: string;
  status: StoredAccessGrant["status"];
  routeId: string;
  principalId: string;
  grant: StoredAccessGrant;
  gsi1pk?: string;
  gsi1sk?: string;
}

export interface LogicalSessionItem {
  pk: string;
  sk: "STATE";
  entity: "logical_session";
  createdAt: string;
  grantId: string;
  routeId: string;
  status: StoredLogicalSession["status"];
  session: StoredLogicalSession;
  gsi1pk: string;
  gsi1sk: string;
}

export interface CredentialLookupItem {
  pk: string;
  sk: "LOOKUP";
  entity: "credential_lookup";
  createdAt: string;
  expiresAtSeconds: number;
  grantId: string;
  credentialId: string;
}

export interface HealthItem {
  pk: string;
  sk: string;
  entity: "health";
  createdAt: string;
  health: ProviderHealth;
}

export interface ProviderInventoryItem {
  pk: string;
  sk: "LATEST";
  entity: "provider_inventory";
  createdAt: string;
  snapshot: ProviderInventorySnapshot;
}

export interface CapabilityHealthItem {
  pk: "CAPABILITY_HEALTH#GLOBAL";
  sk: string;
  entity: "capability_health";
  createdAt: string;
  snapshot: CapabilityHealthSnapshot;
}

export interface HealthAlertStateItem {
  pk: "HEALTH_ALERT_STATE#GLOBAL";
  sk: CapabilityName;
  entity: "health_alert_state";
  createdAt: string;
  state: HealthAlertState;
}

export interface HealthAlertEventItem {
  pk: string;
  sk: "EVENT";
  entity: "health_alert_event";
  createdAt: string;
  event: HealthAlertEvent;
}

export interface HealthAlertDeliveryItem {
  pk: string;
  sk: string;
  entity: "health_alert_delivery_pending" | "health_alert_delivery_delivered" | "health_alert_delivery_failed";
  createdAt: string;
  delivery: HealthAlertDelivery;
}

export interface ActiveTunnelItem {
  pk: string;
  sk: "STATE";
  entity: string;
  createdAt: string;
  gsi1pk: string;
  gsi1sk: string;
  expiresAtSeconds: number;
  tunnel: ActiveTunnel;
}

export interface CapacityCircuitItem {
  pk: string;
  sk: "STATE";
  entity: "capacity_circuit";
  createdAt: string;
  expiresAtSeconds: number;
  state: CapacityCircuitState;
}

export interface DeploymentDrainItem {
  pk: string;
  sk: "DRAIN";
  entity: "deployment_drain";
  createdAt: string;
  state: DeploymentDrainState;
}

export interface UsageRecordItem {
  pk: string;
  sk: "RECORD";
  entity: string;
  createdAt: string;
  record: UsageRecord;
}

export interface UsageRollupItem {
  pk: string;
  sk: string;
  entity: "usage_rollup";
  createdAt: string;
  rollup: UsageRollup;
}

export interface UsageReconciliationItem {
  pk: string;
  sk: "RECORD";
  entity: "usage_reconciliation";
  createdAt: string;
  reconciliation: UsageReconciliation;
}

export interface UsageAlertEventItem {
  pk: string;
  sk: "EVENT";
  entity: "usage_alert_event";
  createdAt: string;
  event: UsageAlertEvent;
}

export interface CapacityPressureEvidenceItem {
  pk: string;
  sk: "EVIDENCE";
  entity: "capacity_pressure_evidence";
  createdAt: string;
  evidence: CapacityPressureEvidence;
}

export function routeKey(id: string): { pk: string; sk: string } {
  return { pk: `ROUTE#${id}`, sk: "STATE" };
}

export function accessGrantKey(id: string): { pk: string; sk: "STATE" } {
  return { pk: `ACCESS_GRANT#${id}`, sk: "STATE" };
}

export function logicalSessionKey(id: string): { pk: string; sk: "STATE" } {
  return { pk: `LOGICAL_SESSION#${id}`, sk: "STATE" };
}

export function logicalSessionItem(session: StoredLogicalSession): LogicalSessionItem {
  return {
    ...logicalSessionKey(session.id),
    entity: "logical_session",
    createdAt: session.createdAt,
    grantId: session.grantId,
    routeId: session.routeId,
    status: session.status,
    session,
    gsi1pk: `GRANT#${session.grantId}`,
    gsi1sk: `${session.createdAt}#${session.id}`,
  };
}

export function credentialLookupKey(username: string): { pk: string; sk: "LOOKUP" } {
  return { pk: `CREDENTIAL#${username}`, sk: "LOOKUP" };
}

export function capacityCircuitKey(provider: ProviderId, candidateKey: string): { pk: string; sk: "STATE" } {
  return { pk: `CAPACITY_CIRCUIT#${provider}#${candidateKey}`, sk: "STATE" };
}

export function conditionalNotFound(error: unknown): never {
  if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) {
    throw new NotFoundError();
  }
  throw error;
}

export function credentialUsable(credential: StoredAccessGrantCredential, nowMs: number): boolean {
  return (
    credential.status !== "revoked" &&
    Date.parse(credential.expiresAt) > nowMs &&
    (credential.revokeAt === undefined || Date.parse(credential.revokeAt) > nowMs)
  );
}

export function grantItem(grant: StoredAccessGrant): AccessGrantItem {
  return {
    ...accessGrantKey(grant.id),
    entity: "access_grant",
    createdAt: grant.createdAt,
    status: grant.status,
    routeId: grant.routeId,
    principalId: grant.principalId,
    grant,
    gsi1pk: `ROUTE#${grant.routeId}`,
    gsi1sk: `${grant.createdAt}#${grant.id}`,
  };
}

export function credentialLookupItem(grantId: string, credential: StoredAccessGrantCredential): CredentialLookupItem {
  return {
    ...credentialLookupKey(credentialUsername(credential.id)),
    entity: "credential_lookup",
    createdAt: credential.createdAt,
    expiresAtSeconds: Math.ceil(Date.parse(credential.expiresAt) / 1_000),
    grantId,
    credentialId: credential.id,
  };
}

export function decodeCredentialLookup(item: unknown): { grantId: string; credentialId: string } {
  const record = expectRecord(item, "DynamoDB credential-lookup item");
  const expectedKeys = new Set(["pk", "sk", "entity", "createdAt", "expiresAtSeconds", "grantId", "credentialId"]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key))) {
    throw new TypeError("DynamoDB credential-lookup item has unexpected fields");
  }
  expectNonEmptyString(record["pk"], "DynamoDB credential-lookup item pk");
  if (record["sk"] !== "LOOKUP") throw new TypeError("DynamoDB credential-lookup item has an invalid sort key");
  if (record["entity"] !== "credential_lookup") throw new TypeError("DynamoDB credential-lookup item has an invalid entity");
  expectIsoTimestamp(record["createdAt"], "DynamoDB credential-lookup item createdAt");
  expectInteger(record["expiresAtSeconds"], "DynamoDB credential-lookup item expiresAtSeconds", 1);
  return {
    grantId: expectNonEmptyString(record["grantId"], "DynamoDB credential-lookup item grantId"),
    credentialId: expectNonEmptyString(record["credentialId"], "DynamoDB credential-lookup item credentialId"),
  };
}
