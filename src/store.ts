import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "./errors.js";
import type {
  ProviderHealth,
  PublicRoute,
  RouteProfile,
  RouteStatus,
  StoredRoute,
} from "./types.js";

interface RouteRow {
  id: string;
  name: string;
  kind: StoredRoute["kind"];
  targeting_json: string;
  rotation_json: string;
  token_salt: string;
  token_hash: string;
  provider: StoredRoute["provider"];
  endpoint_id: string | null;
  status: RouteStatus;
  last_error: string | null;
  rotation_epoch: number;
  created_at: string;
  updated_at: string;
}

interface HealthRow {
  provider: ProviderHealth["provider"];
  state: ProviderHealth["state"];
  checked_at: string;
  message: string | null;
}

function routeFromRow(row: RouteRow): StoredRoute {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    targeting: JSON.parse(row.targeting_json) as StoredRoute["targeting"],
    rotation: JSON.parse(row.rotation_json) as StoredRoute["rotation"],
    tokenSalt: row.token_salt,
    tokenHash: row.token_hash,
    provider: row.provider,
    ...(row.endpoint_id === null ? {} : { endpointId: row.endpoint_id }),
    status: row.status,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    rotationEpoch: row.rotation_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicRoute(route: StoredRoute): PublicRoute {
  return {
    id: route.id,
    name: route.name,
    kind: route.kind,
    targeting: route.targeting,
    rotation: route.rotation,
    provider: route.provider,
    ...(route.endpointId === undefined ? {} : { endpointId: route.endpointId }),
    status: route.status,
    ...(route.lastError === undefined ? {} : { lastError: route.lastError }),
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

export class RouteStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('residential', 'mobile')),
        targeting_json TEXT NOT NULL,
        rotation_json TEXT NOT NULL,
        token_salt TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('bright_data', 'proxidize')),
        endpoint_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('ready', 'rotating', 'failed', 'revoked')),
        last_error TEXT,
        rotation_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routes_endpoint_id ON routes(endpoint_id) WHERE status != 'revoked';
      CREATE TABLE IF NOT EXISTS provider_health (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('healthy', 'degraded', 'unhealthy')),
        checked_at TEXT NOT NULL,
        message TEXT
      );
    `);
  }

  create(
    id: string,
    profile: RouteProfile,
    token: string,
    provider: StoredRoute["provider"],
    endpointId?: string,
  ): StoredRoute {
    const now = new Date().toISOString();
    const salt = randomBytes(16).toString("hex");
    const tokenHash = scryptSync(token, salt, 32).toString("hex");
    this.#database.prepare(`
      INSERT INTO routes (
        id, name, kind, targeting_json, rotation_json, token_salt, token_hash,
        provider, endpoint_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
    `).run(
      id,
      profile.name,
      profile.kind,
      JSON.stringify(profile.targeting),
      JSON.stringify(profile.rotation),
      salt,
      tokenHash,
      provider,
      endpointId ?? null,
      now,
      now,
    );
    return this.get(id);
  }

  get(id: string, includeRevoked = false): StoredRoute {
    const sql = includeRevoked
      ? "SELECT * FROM routes WHERE id = ?"
      : "SELECT * FROM routes WHERE id = ? AND status != 'revoked'";
    const row = this.#database.prepare(sql).get(id) as unknown as RouteRow | undefined;
    if (row === undefined) throw new NotFoundError();
    return routeFromRow(row);
  }

  list(): StoredRoute[] {
    const rows = this.#database
      .prepare("SELECT * FROM routes WHERE status != 'revoked' ORDER BY created_at ASC")
      .all() as unknown as RouteRow[];
    return rows.map(routeFromRow);
  }

  authenticate(id: string, token: string): StoredRoute | undefined {
    let route: StoredRoute;
    try {
      route = this.get(id);
    } catch {
      return undefined;
    }
    const candidate = scryptSync(token, route.tokenSalt, 32);
    const expected = Buffer.from(route.tokenHash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? route : undefined;
  }

  revoke(id: string): void {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE routes SET status = 'revoked', updated_at = ? WHERE id = ? AND status != 'revoked'")
      .run(now, id);
    if (result.changes === 0) throw new NotFoundError();
  }

  setStatus(id: string, status: RouteStatus, lastError?: string): StoredRoute {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE routes SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status != 'revoked'")
      .run(status, lastError ?? null, now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  incrementRotationEpoch(id: string): StoredRoute {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(`
        UPDATE routes
        SET rotation_epoch = rotation_epoch + 1, updated_at = ?
        WHERE id = ? AND status != 'revoked'
      `)
      .run(now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  assignmentCount(endpointId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM routes WHERE endpoint_id = ? AND status != 'revoked'")
      .get(endpointId) as { count: number };
    return row.count;
  }

  saveHealth(health: ProviderHealth): void {
    this.#database.prepare(`
      INSERT INTO provider_health(provider, state, checked_at, message)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = excluded.state,
        checked_at = excluded.checked_at,
        message = excluded.message
    `).run(health.provider, health.state, health.checkedAt, health.message ?? null);
  }

  listHealth(): ProviderHealth[] {
    const rows = this.#database.prepare("SELECT * FROM provider_health ORDER BY provider").all() as unknown as HealthRow[];
    return rows.map((row) => ({
      provider: row.provider,
      state: row.state,
      checkedAt: row.checked_at,
      ...(row.message === null ? {} : { message: row.message }),
    }));
  }

  close(): void {
    this.#database.close();
  }
}
