# Operations guide

This guide is the shipped-v0 runbook for deploying, configuring, monitoring, and operating Profound Proxy Router. Caller integration is documented separately in the [consumer guide](USAGE.md); contribution and test workflows are in the [development guide](DEVELOPMENT.md).

## Service architecture

AWS is the only deployment provider implemented in v0. The SST module deploys independent runtime and health boundaries rather than one monolith:

| Component                   | Responsibility                                                | Local mode/port              | AWS placement                                        |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Data plane                  | HTTP/HTTPS and SOCKS5 proxy listeners                         | `data-plane`; `8080`, `1080` | ECS Fargate behind an internal Network Load Balancer |
| Control plane               | Routes, grants, providers, readiness, OpenAPI                 | `control-plane`; `8081`      | ECS Fargate behind an internal load balancer         |
| Health aggregator           | Provider/passive/synthetic health and alert creation          | `health-aggregator`; `8082`  | Internal ECS Fargate service                         |
| Internal dashboard          | Capability status, usage, cost, reconciliation                | `status`; `8083`             | Internal ECS Fargate service                         |
| Notification worker         | Signed webhook delivery                                       | `notification`; `8084`       | Internal ECS Fargate service                         |
| Usage accounting            | Durable rollups and provider-cost reconciliation              | `usage-accounting`; `8085`   | Internal ECS Fargate service                         |
| Public canary               | Signed source-IP/geography observation                        | `canary`; `8090`             | API Gateway and Lambda in an isolated canary VPC     |
| Product telemetry collector | OTLP buffering/filtering/export and passive health forwarding | n/a                          | ECS Fargate in the product VPC                       |
| Canary telemetry collector  | Isolated canary OTLP export                                   | n/a                          | ECS Fargate in the canary VPC                        |

`SERVICE_MODE=proxy` starts the combined local data and control planes. `integration-target` is a controlled recipient used by tests and is not a production component.

The product VPC holds provider credentials, route state, and customer attribution. The public canary has no provider credentials, customer data, internal routes, or path into the product VPC. Target traffic always travels through a selected provider and never falls back to a direct connection.

## Local operation

### Install

Installation and startup are separate steps:

```sh
pnpm install
pnpm sst install
```

### Start the proxy and control plane

```sh
pnpm dev
```

The defaults are offline and safe for local development:

- provider mode: local Bright Data and Proxidize simulators;
- persistence: `./data/profound.db` with SQLite;
- control principal: `local-dev` authenticated by `change-me`;
- all listeners: loopback only.

Check the process:

```sh
curl -sS http://127.0.0.1:8081/health/live
curl -sS http://127.0.0.1:8081/health/ready
```

### Start the supporting services

Run each command in a separate terminal. The default SQLite path lets every mode share local state.

```sh
SERVICE_MODE=canary \
CANARY_SIGNING_SECRET=local-canary-secret \
pnpm dev
```

```sh
SERVICE_MODE=health-aggregator \
HEALTH_AGGREGATOR_TOKEN=local-health-secret \
CANARY_SIGNING_SECRET=local-canary-secret \
HEALTH_CANARY_URL=http://127.0.0.1:8090/v1/challenge \
pnpm dev
```

```sh
SERVICE_MODE=status \
HEALTH_AGGREGATOR_TOKEN=local-health-secret \
HEALTH_AGGREGATOR_URL=http://127.0.0.1:8082 \
pnpm dev
```

```sh
SERVICE_MODE=usage-accounting pnpm dev
```

```sh
SERVICE_MODE=notification \
HEALTH_ALERT_DESTINATIONS_JSON='{"version":"local","destinations":[]}' \
pnpm dev
```

The dashboard is at `http://127.0.0.1:8083/`. Without a dedicated health route, provider and passive health work while `Health Verification` reports that no synthetic proxy validation has run.

## Configuration contract

[`.env.example`](../.env.example) is the complete environment-variable reference and must be updated whenever a new setting is introduced. The tables below group the values operators normally change.

### Core data and control plane

| Variable                       | Default                                          | Notes                                                          |
| ------------------------------ | ------------------------------------------------ | -------------------------------------------------------------- |
| `PROVIDER_MODE`                | `mock`                                           | `mock` or `live`; developer SST stages reject `live`.          |
| `PERSISTENCE_BACKEND`          | `sqlite`                                         | `sqlite` or `dynamodb`.                                        |
| `SQLITE_PATH`                  | `./data/profound.db`                             | Shared local state path.                                       |
| `ROUTE_TABLE_NAME`             | none                                             | Required for DynamoDB; supplied by SST.                        |
| `CONTROL_API_TOKEN`            | `change-me`                                      | Placeholder accepted only for loopback mock mode.              |
| `CONTROL_API_USER_ID`          | `local-dev`                                      | Trusted principal attached to owned grants and telemetry.      |
| `CONTROL_API_IDENTITIES_JSON`  | none                                             | Complete token-to-principal map; replaces the single identity. |
| `ALLOWED_TARGET_PORTS`         | `80,443`                                         | Comma-separated public TCP ports accepted by both listeners.   |
| `CONNECT_TIMEOUT_MS`           | `10000`                                          | Per-candidate establishment limit; maximum 10 seconds.         |
| `OPERATION_TIMEOUT_MS`         | `30000`                                          | Overall establishment limit; maximum 30 seconds.               |
| `STREAM_IDLE_TIMEOUT_MS`       | `60000` local                                    | Post-establishment application idle safeguard.                 |
| `MAX_HEADER_BYTES`             | `32768`                                          | HTTP header and bounded handshake limit.                       |
| `RETRY_MAX_ATTEMPTS`           | `4`                                              | Central default, range 1–6.                                    |
| `PROXIDIZE_EXACT_CITY_SUPPORT` | mock: `provider_guaranteed`; live: `unsupported` | Set to guaranteed only with an established vendor contract.    |

Never bind the control plane beyond loopback with `change-me`. Configuration validation rejects the placeholder in live mode or on a non-loopback control host.

### Provider credentials

Live mode requires all of the following:

- `BRIGHT_DATA_CUSTOMER_ID`
- `BRIGHT_DATA_ZONE`
- `BRIGHT_DATA_PASSWORD`
- `BRIGHT_DATA_API_KEY`
- `PROXIDIZE_API_TOKEN`

Optional endpoint overrides are `BRIGHT_DATA_HOST`, `BRIGHT_DATA_PORT`, `BRIGHT_DATA_STATUS_API_URL`, and `PROXIDIZE_API_BASE_URL`. Keep provider configuration in SST secrets or a local secret source, never committed environment files.

### Persistence

SQLite is disposable local state. DynamoDB is the deployed system of record for:

- route profiles and access-grant verifier hashes;
- grant-scoped device leases and active tunnel/deployment drain state;
- provider and capability-health history;
- immutable usage records, cost rollups, and reconciliation evidence;
- alert episodes and notification delivery state.

The AWS table uses on-demand capacity and point-in-time recovery. Production removal is protected. V0 is pre-stable and carries only migrations required by the current design; do not preserve obsolete pre-v0 shapes in disposable environments.

## AWS deployment with SST

### Prerequisites

- Docker is running.
- The intended AWS identity is active.
- SST dependencies are installed.
- Three Axiom datasets and a scoped ingest token exist.
- GeoLite2 credentials are available to the deployment pipeline.
- Internal DNS, ACM certificates, and source CIDRs are known for production.

Verify the identity before every manual deployment:

```sh
aws sts get-caller-identity
```

### Stage policy

| Stage                | Classification     | Provider default | Data-plane tasks | Removal                                      |
| -------------------- | ------------------ | ---------------- | ---------------- | -------------------------------------------- |
| `prod`, `production` | production         | live             | 2–4              | protected/retain                             |
| `staging`, `preview` | shared             | mock             | 1–2              | removable                                    |
| `ci`, `ci-*`         | CI                 | mock             | 1–2              | removable; includes transport test recipient |
| any other valid name | personal developer | mock only        | 1–2              | removable                                    |

Stage names are 1–32 lowercase letters, digits, or hyphens. Use a personal name such as `alice-dev`; do not share a generic development stage. Override data-plane bounds with `MIN_TASKS` and `MAX_TASKS`.

### Telemetry backend

Create three Axiom datasets before deployment:

- `<app>-<stage>-logs`: Logs + Traces event dataset;
- `<app>-<stage>-traces`: Logs + Traces event dataset;
- `<app>-<stage>-metrics`: Metrics dataset.

All three default to 30-day retention. `TELEMETRY_RETENTION_DAYS` records the expected policy but does not create or mutate the external datasets; configure the same retention in Axiom. `AXIOM_OTLP_ENDPOINT` and `AXIOM_*_DATASET` override the defaults.

Store a token scoped only to ingest into those datasets:

```sh
pnpm sst secret set AxiomIngestToken \
  'AXIOM_DATASET_SCOPED_INGEST_TOKEN' \
  --stage staging
```

The token is injected into collectors, not application containers or the canary Lambda.

### Required stage secrets

Every stage requires independent control, health, canary, and telemetry secrets:

```sh
pnpm sst secret set ControlApiToken \
  'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage staging
pnpm sst secret set HealthAggregatorToken \
  'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage staging
pnpm sst secret set CanarySigningSecret \
  'REPLACE_WITH_A_SIGNING_SECRET' --stage staging
pnpm sst secret set AxiomIngestToken \
  'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage staging
```

One `ControlApiToken` represents one principal. To authorize multiple principals, store the complete mapping and enable it at deployment:

```sh
pnpm sst secret set ControlApiIdentities \
  '{"TOKEN_FOR_USER_ONE":"user-one","TOKEN_FOR_SERVICE_TWO":"service-two"}' \
  --stage staging

CONTROL_API_IDENTITIES_CONFIGURED=true \
pnpm aws:deploy --stage staging
```

The map replaces the single-token identity set. Include every principal that must retain access.

### GeoIP bundle

The canary uses a versioned MaxMind GeoLite2 City MMDB. Prepare it before deployment and at least twice weekly in automation:

```sh
MAXMIND_ACCOUNT_ID='MAXMIND_ACCOUNT_ID' \
MAXMIND_LICENSE_KEY='MAXMIND_LICENSE_KEY' \
pnpm geoip:prepare
```

The script performs an authenticated HEAD check, downloads only a newer build, validates it, and atomically stages the MMDB plus metadata under `.sst/geoip`. Without a local MMDB, local canary responses explicitly report `geo.status: "unavailable"` rather than inventing geography.

### Deploy a mock shared stage

Use documentation-only example CIDRs as placeholders; replace them with the actual trusted sources before running:

```sh
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
pnpm aws:deploy --stage staging
```

Non-production uses provider simulators by default. SST prints internal proxy, control, dashboard, health, accounting, notification, canary, and telemetry metadata. Internal names resolve only from the product VPC or an SST tunnel.

### Deploy production

Set vendor secrets:

```sh
pnpm sst secret set BrightDataCustomerId 'CUSTOMER_ID' --stage production
pnpm sst secret set BrightDataZone 'ZONE' --stage production
pnpm sst secret set BrightDataPassword 'PASSWORD' --stage production
pnpm sst secret set BrightDataApiKey 'API_KEY' --stage production
pnpm sst secret set ProxidizeApiToken 'TOKEN' --stage production
```

Also set the four required stage secrets described above for `production`. Then deploy with explicit private domains, validated certificates, and trusted CIDRs:

```sh
PROVIDER_MODE=live \
PROXY_DOMAIN='proxy.internal.example.com' \
PROXY_CERT_ARN='arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME' \
CONTROL_DOMAIN='proxy-control.internal.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32,198.51.100.0/24' \
MIN_TASKS=2 \
MAX_TASKS=4 \
pnpm aws:deploy --stage production
```

The domain names above are syntax placeholders and must be replaced. Production rejects missing proxy/control domains, missing proxy certificate, and unspecified source CIDRs. For externally managed control DNS, provide `CONTROL_CERT_ARN` and create the alias yourself. Point the private proxy name at the emitted `loadBalancerHost`.

The proxy NLB terminates TLS on port `8080` for HTTP proxy traffic. The control plane terminates HTTPS on port `443`. SOCKS5 remains unencrypted on port `1080` and is private-network only.

AWS fixes the TLS-listener idle timeout at 350 seconds. The configurable SOCKS5 TCP listener defaults to 1,200 seconds, and target-group deregistration defaults to 300 seconds. Set `NLB_TCP_IDLE_TIMEOUT_SECONDS` and `NLB_DEREGISTRATION_DELAY_SECONDS` deliberately; neither changes the logical 15-minute device-lease timeout.

### Personal SST development

Create secrets for a personal stage and start SST dev:

```sh
pnpm sst secret set ControlApiToken 'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage alice-dev
pnpm sst secret set HealthAggregatorToken 'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage alice-dev
pnpm sst secret set CanarySigningSecret 'REPLACE_WITH_A_SIGNING_SECRET' --stage alice-dev
pnpm sst secret set AxiomIngestToken 'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage alice-dev
pnpm sst:dev --stage alice-dev
```

Application modes with a dev command run locally; SST prints their addresses. This does not deploy the production-shaped Fargate topology. Stop with Ctrl-C and remove persistent stage resources:

SST's VPC tunnel reserves local port `1080`, so `sst dev` runs and advertises the local SOCKS5 listener on `127.0.0.1:1081`. The standalone `pnpm dev` command and deployed ECS service continue to use port `1080`.

```sh
pnpm aws:remove --stage alice-dev
```

## Health and verification

The control plane exposes `/health/live` and `/health/ready`. The accounting and notification services expose the same pair. The dashboard exposes `/health/live`; the public canary exposes `/health/live` and signed `POST /v1/challenge`.

The health aggregator combines:

- provider status/control-plane checks;
- passive outcomes forwarded from normal proxy traffic by the collector;
- optional signed end-to-end requests through a dedicated proxy grant to the isolated canary.

It persists global capabilities `all_traffic`, `authenticated_traffic`, `unauthenticated_traffic`, and `health_verification` with `operational`, `degraded`, or `unavailable` status. Evidence freshness is reported separately: quiet traffic or a missing synthetic route may make validation stale without declaring an outage.

Aggregator endpoints:

| Endpoint                        | Authentication | Purpose                                 |
| ------------------------------- | -------------- | --------------------------------------- |
| `GET /health/live`              | none           | Process liveness                        |
| `GET /health/ready`             | none           | Refresh/readiness state                 |
| `GET /v1/status`                | health bearer  | Current snapshot                        |
| `POST /v1/passive-signals/otlp` | health bearer  | Collector-filtered passive outcomes     |
| `POST /v1/validate`             | health bearer  | Cooldown-coalesced synthetic validation |

### Configure the synthetic route

After the initial deploy, create a dedicated unauthenticated route and retain its access-grant URL. Store the separated username/token and redeploy:

```sh
pnpm sst secret set HealthProxyUsername 'ACCESS_GRANT_ID' --stage production
pnpm sst secret set HealthProxyPassword 'ACCESS_GRANT_TOKEN' --stage production

HEALTH_SYNTHETIC_ROUTE_CONFIGURED=true \
PROVIDER_MODE=live \
PROXY_DOMAIN='proxy.internal.example.com' \
PROXY_CERT_ARN='arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME' \
CONTROL_DOMAIN='proxy-control.internal.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
pnpm aws:deploy --stage production
```

The canary accepts only short-lived signed, non-replayable challenges. In AWS, API Gateway's `requestContext.http.sourceIp` is authoritative; caller-supplied forwarding headers are ignored.

## Internal dashboard

The dashboard root shows 30-day request count, transfer, device lease time, current and time-weighted allocation utilization, unhealthy paid capacity, attributed cost, capability state, freshness, and geography evidence.

Programmatic endpoints are internal and unauthenticated at the application layer; network access is the v0 boundary:

| Endpoint                          | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `GET /api/status`                 | Latest snapshot plus stale/age fields                  |
| `GET /api/status/history?limit=N` | Durable capability history                             |
| `GET /api/status/geographies`     | Latest geography evidence                              |
| `POST /api/status/validate`       | Proxy a synthetic validation request to the aggregator |
| `GET /api/usage`                  | Usage and cost rollups                                 |
| `GET /api/usage/reconciliations`  | Provider total comparisons and variance evidence       |

`/api/usage` supports:

- `from` and `to` ISO timestamps;
- `preset=day|week|month`;
- `interval=hour|day|week|month`;
- `groupBy=provider|customer|user|route|country|city|outcome`;
- `provider=bright_data|proxidize|unresolved`;
- `customerId`, `userId`, `routeId`, `country`, `city`, and `outcome` filters.

Example:

```sh
curl -sS \
  'http://127.0.0.1:8083/api/usage?preset=week&interval=day&groupBy=provider'
```

## Usage and cost accounting

The durable usage ledger, not OTLP, is authoritative. Every upstream attempt records an idempotent unsampled event containing logical operation, customer, principal/grant, route, provider, outcome, byte counts, lease context, and historical pricing version.

- Bright Data cost is estimated from billable bytes and the historical per-GiB price.
- Proxidize cost is estimated from unioned exclusive device lease/capacity time, including idle lease time.
- Hour/day/week/month rollups retain group attribution and whether cost is `estimated` or `reconciled`.
- Configured provider totals replace the overall authoritative spend for matching periods.
- Unassigned device capacity and unexplained reconciliation differences are posted to the synthetic `Unallocated` customer, never silently prorated to customers.
- The component provides internal billing inputs only. Invoice generation, approval, adjustments, collection, and external audit are out of scope.

The accounting worker can read static `PROVIDER_COST_TOTALS_JSON` and `UNALLOCATED_DEVICE_CAPACITY_JSON`, or poll `USAGE_ACCOUNTING_SOURCE_URL`. The optional source returns:

```json
{
  "providerTotals": [],
  "unallocatedDeviceCapacity": []
}
```

Protect it with the `UsageAccountingSourceToken` SST secret and `USAGE_ACCOUNTING_SOURCE_TOKEN_CONFIGURED=true` when required.

Each reconciliation persists estimated total, reported total, variance, source version, and `Unallocated` attribution. Default policy:

- ignore relative thresholds until the absolute variance exceeds `$1`;
- warning above `5%`;
- error above `15%`;
- escalate repeated warnings to error.

Configure these initial thresholds with `USAGE_VARIANCE_ABSOLUTE_FLOOR_USD`, `USAGE_VARIANCE_WARNING_RELATIVE`, and `USAGE_VARIANCE_ERROR_RELATIVE`. Revisit them using observed data.

## Alerting

The health aggregator owns capability alerts and recovery events in v0. `unavailable` alerts are immediate. `degraded` alerts wait five minutes by default. An alerted capability emits one recovery when it returns to `operational`. Geography is context on global events, not a separate subscription.

Configure signed HTTPS webhooks as one versioned secret:

```sh
pnpm sst secret set HealthAlertDestinations \
  '{"version":"2026-07-15","destinations":[{"id":"primary-ops","url":"https://alerts.example.com/profound","secret":"REPLACE_WITH_A_LONG_SIGNING_SECRET"}]}' \
  --stage staging

HEALTH_ALERTING_CONFIGURED=true \
HEALTH_ALERT_CONFIGURATION_VERSION='2026-07-15' \
HEALTH_ALERT_DESTINATION_IDS='primary-ops' \
pnpm aws:deploy --stage staging
```

`alerts.example.com` is a syntax placeholder; supply a reachable operator endpoint. Each delivery contains `x-profound-event-id`, `x-profound-timestamp`, and `x-profound-signature`. The signature is `sha256=<hex HMAC-SHA256>` over `<timestamp>.<raw JSON body>`. Failures retry with exponential backoff and are persisted without changing the evaluated health state.

Capability alert ownership cannot be transferred in v0. Axiom monitors may own separate engineering conditions such as missing telemetry, unusual usage, or performance trends.

## Telemetry and data handling

Applications send backend-neutral OTLP to task-local pinned ADOT collectors. Collectors batch, queue, retry, filter, and export logs, traces, and metrics to their dedicated Axiom datasets. The data-plane collector forwards only passive-health log records to the health aggregator. Stderr is an error-only bootstrap/exporter fallback, not the canonical telemetry path.

V0 samples every trace and every usage record. Per-attempt spans/logs include provider, operation/attempt IDs, outcome, latency, retry context, bytes, normalized candidate evidence, expected/observed city, and DNS-resolution evidence. Plain HTTP may include target method, hostname, and status. Tunnel telemetry contains only protocol, target host/port, establishment result, duration, and bytes.

Never emitted:

- request or response bodies;
- raw headers or query strings;
- cookies or target authorization values;
- control, access-grant, or provider credentials;
- unsanitized exception text.

High-cardinality route, grant, user, peer, device, session, and IP identifiers stay out of metric attributes. Public-canary access/security events share the log dataset with `log.category=security`.

## Release and connection draining

GitHub Actions builds an immutable image once and promotes the same digest through environments. The proxy uses ECS native blue/green target groups. Established HTTPS and SOCKS5 tunnels write durable deployment leases so a retiring deployment can drain safely.

After traffic shift:

- check retiring tunnels every 15 minutes;
- notify users hourly after one hour;
- escalate to operations after three hours;
- terminate remaining tunnels after six hours unless a time-bounded extension exists.

The ECS bake window keeps the old tasks available for six hours. Routine route/grant revocation also preserves established traffic; emergency revocation is the explicit kill switch.

## Operational runbook

### Control readiness is failing

1. Check `/health/live` to distinguish process failure from readiness failure.
2. Check both normalized provider states and provider control credentials.
3. Confirm DynamoDB access and `ROUTE_TABLE_NAME` in AWS.
4. Confirm that a live deployment has every required provider secret.
5. Do not weaken readiness or enable direct fallback.

### Clients receive HTTP 407 or SOCKS5 authentication failure

1. Confirm the username is the access-grant ID, not the route ID.
2. Check credential `expiresAt`, `revokeAt`, and grant/route status through the control plane.
3. Confirm URL encoding was preserved when a proxy URL was split into username/password fields.
4. Rotate routinely if in the renewal window; emergency-rotate if disclosure is possible.
5. Remember that a secret cannot be retrieved after issuance.

### Provider unavailable or route creation fails

1. Read the normalized error and `/v1/providers/health`.
2. Compare route protocol, country/city, carrier, rotation, session, and target-port requirements with `/v1/providers`.
3. For authenticated routes, confirm an exact-city-capable provider is available.
4. Check device capacity and leases for Proxidize.
5. Remove a debugging `forceProvider` only when policy permits fallback; never bypass incompatibility.

### Health is stale but not unavailable

1. Check the provider refresh timestamp.
2. Confirm passive-health OTLP records reach the aggregator.
3. Confirm the synthetic grant exists and can reach the signed canary.
4. Distinguish quiet traffic from a failed signal path before paging.

### Reconciliation variance is warning/error

1. Verify provider total period boundaries and source version.
2. Confirm historical price versions and byte/lease dimensions.
3. Inspect `Unallocated` capacity and variance entries.
4. Treat repeated warning escalation as actionable even below the 15% single-period threshold.
5. Correct source/accounting data; do not silently reassign variance to customers.

### Telemetry is missing

1. Check application error-only stderr for exporter/bootstrap failures.
2. Check the task-local ADOT collector health and queue/export metrics.
3. Verify the scoped token, endpoint, dataset names, and external retention.
4. Confirm network egress from both product and isolated canary VPCs.
5. Do not add secrets or high-cardinality identifiers to metrics as a debugging shortcut.

### Long-lived tunnels block a release

1. Inspect durable active-tunnel records and retiring deployment state.
2. Confirm the blue/green target shift completed before draining.
3. Follow the 1h/3h/6h notification/escalation/termination policy.
4. Record only approved time-bounded extensions.
5. Use emergency termination only for the documented security or drain condition.

## Removal and recovery

Remove disposable stages promptly:

```sh
pnpm aws:remove --stage staging
```

Production resources are protected and the production table is retained. Recover durable state with DynamoDB point-in-time recovery according to the platform account's backup procedure. Provider credentials and SST secrets are external to DynamoDB and must be recoverable through the organization's secret-management process.

After recovery or an ECS replacement, verify route authentication, access-grant metadata, device leases, provider/capability state, accounting rollups, and alert delivery before reopening traffic.

## Production readiness checklist

- Required live provider smoke tests pass with owned credentials.
- Private proxy/control DNS and ACM certificates are valid.
- Data- and control-plane source CIDRs are least privilege.
- SOCKS5 is reachable only through the trusted private network.
- Axiom datasets have the intended kind and 30-day default retention.
- GeoIP bundle preparation runs at least twice weekly.
- Control identities, rotation ownership, and emergency procedures are documented.
- Synthetic route and signed canary validate the normal proxy path.
- Alert webhook signatures and recovery delivery are tested.
- Usage reconciliation source, thresholds, and `Unallocated` handling are reviewed.
- DynamoDB point-in-time recovery and production protection are enabled.
- A deployed integration suite has passed for the immutable release image.
- Repository protection and OIDC settings match [repository-and-release-settings.md](repository-and-release-settings.md).
