# Operations guide

This guide is the shipped-v0 runbook for deploying, configuring, monitoring, and operating Profound Proxy Router. The [capability map](CAPABILITIES.md) explains which requirements are exercised by `pnpm demo` and which rely on the production services described here. Caller integration is documented separately in the [consumer guide](USAGE.md); contribution and test workflows are in the [development guide](DEVELOPMENT.md).

## Service architecture

AWS is the only deployment provider implemented in v0. The SST module deploys independent runtime and health boundaries rather than one monolith:

| Component                   | Responsibility                                                | Local mode/port              | AWS placement                                      |
| --------------------------- | ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| Data plane                  | HTTP/HTTPS and SOCKS5 proxy listeners                         | `data-plane`; `8080`, `1080` | ECS Fargate behind a private Network Load Balancer |
| Control plane               | Routes, grants, providers, readiness, OpenAPI                 | `control-plane`; `8081`      | ECS Fargate behind a private load balancer         |
| Health aggregator           | Provider/passive/synthetic health and alert creation          | `health-aggregator`; `8082`  | Private ECS Fargate service                        |
| Company-facing dashboard    | Capability status, usage, cost, reconciliation                | `status`; `8083`             | Private ECS Fargate service                        |
| Notification worker         | Signed webhook delivery                                       | `notification`; `8084`       | Private ECS Fargate service                        |
| Usage accounting            | Durable rollups and provider-cost reconciliation              | `usage-accounting`; `8085`   | Private ECS Fargate service                        |
| Public canary               | Signed source-IP/geography observation                        | `canary`; `8090`             | API Gateway and Lambda in an isolated canary VPC   |
| Product telemetry collector | OTLP buffering/filtering/export and passive health forwarding | n/a                          | ECS Fargate in the product VPC                     |
| Canary telemetry collector  | Isolated canary OTLP export                                   | n/a                          | ECS Fargate in the canary VPC                      |

`SERVICE_MODE` is internal SST/container wiring. `integration-target` is a controlled recipient used by tests and is not a production component.

The product VPC holds provider credentials, route state, and customer attribution. The public canary has no provider credentials, customer data, company-private routes, or path into the product VPC. Target traffic always travels through a selected provider and never falls back to a direct connection.

## Personal development operation

### Install

Installation and startup are separate steps:

```sh
pnpm install
pnpm sst install
```

### Start the stack

```sh
pnpm sst:dev --stage yourname-dev
```

SST provisions the stage's DynamoDB and supporting AWS resources, then starts the application services locally with generated configuration. Personal stages are safe for development:

- provider mode: local Bright Data and Proxidize simulators;
- persistence: the stage's DynamoDB table;
- control principal: the stage identity authenticated by `change-me`;
- all listeners: loopback only.

Check the process:

```sh
curl -sS http://127.0.0.1:8081/health/live
curl -sS http://127.0.0.1:8081/health/ready
```

The dashboard is at `http://127.0.0.1:8083/`. Without a dedicated health route, provider and passive health work while `Health Verification` reports that no synthetic proxy validation has run. Stop with Ctrl-C and remove the persistent personal stage when finished:

```sh
pnpm aws:remove --stage yourname-dev
```

The dashboard lists non-null profile provider overrides and every current hard-capacity circuit with its provider/candidate, normalized failure class, state, and cooldown. `/api/capacity` additionally exposes the typed routing policy, current least-load evidence, shadow roadmap score components, soft pressure, and circuit state for operator diagnosis.

## Configuration contract

The [configuration and secret-source audit](CONFIGURATION.md) defines the supported SST secrets, six non-secret operator deployment inputs, typed policy, internal runtime wiring, and local/test inputs. The standalone local runtime is fixed to loopback, mock providers, disabled export, and ephemeral memory rather than exposing deployment configuration.

### Provider credentials

Live mode requires all of the following:

- `BRIGHT_DATA_CUSTOMER_ID`
- `BRIGHT_DATA_ZONE`
- `BRIGHT_DATA_PASSWORD`
- `BRIGHT_DATA_API_KEY`
- `PROXIDIZE_API_TOKEN`

SST uses the reviewed v0 endpoints and reads provider credentials only from SST secrets.

### Persistence

DynamoDB is the application system of record for:

- route profiles and access-grant verifier hashes;
- provider-account and proxy-slot inventory snapshots, active connection loads, and deployment drain state;
- TTL-backed provider/candidate capacity circuits, including cooldown and half-open probe ownership;
- provider and capability-health history;
- immutable usage records, cost rollups, and reconciliation evidence;
- alert episodes and notification delivery state.

The AWS table uses on-demand capacity and point-in-time recovery. Production removal is protected. Personal stages are disposable; remove them instead of preserving obsolete pre-v0 state. The local runtime and offline tests use an ephemeral in-memory adapter; Dynamo-specific and deployed acceptance tests verify persistence semantics.

## AWS deployment with SST

### Prerequisites

- Docker is running.
- The intended AWS identity is active.
- SST dependencies are installed.
- Three Axiom datasets and a scoped ingest token exist.
- GeoLite2 credentials are available to the deployment pipeline.
- Private company DNS, ACM certificates, and authorized source CIDRs are known for production.

Verify the identity before every manual deployment:

```sh
aws sts get-caller-identity
```

### Stage policy

| Stage                | Classification     | Provider default | Data-plane tasks | Removal                                      |
| -------------------- | ------------------ | ---------------- | ---------------- | -------------------------------------------- |
| `prod`, `production` | production         | live             | 2–4              | protected/retain                             |
| `staging`            | shared             | live             | 1–2              | removable                                    |
| `preview`            | shared             | mock             | 1–2              | removable                                    |
| `ci`, `ci-*`         | CI                 | mock             | 1–2              | removable; includes transport test recipient |
| any other valid name | personal developer | mock only        | 1–2              | removable                                    |

Stage names are 1–32 lowercase letters, digits, or hyphens. Use a personal name such as `alice-dev`; do not share a generic development stage. Provider mode and data-plane bounds are fixed by the typed stage policy.

### Telemetry backend

Create three Axiom datasets before deployment:

- `<app>-<stage>-logs`: Logs + Traces event dataset;
- `<app>-<stage>-traces`: Logs + Traces event dataset;
- `<app>-<stage>-metrics`: Metrics dataset.

All three use a reviewed 30-day retention expectation. SST fixes the Axiom endpoint and derives dataset names from the application and stage; configure matching external datasets and retention in Axiom.

Store a token scoped only to ingest into those datasets:

```sh
pnpm sst secret set AxiomIngestToken \
  'AXIOM_DATASET_SCOPED_INGEST_TOKEN' \
  --stage staging
```

The token is injected into collectors, not application containers or the canary Lambda.

### Required non-development stage secrets

Every shared, CI, staging, and production stage requires independent control, health, canary, and telemetry secrets:

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

One `ControlApiToken` represents one principal. Multi-principal identities are disabled in the initial v0 stage policy. To enable them, make a reviewed change to `stage.features.controlApiIdentities`, then store the complete mapping before deployment:

```sh
pnpm sst secret set ControlApiIdentities \
  '{"TOKEN_FOR_USER_ONE":"user-one","TOKEN_FOR_SERVICE_TWO":"service-two"}' \
  --stage staging

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
pnpm aws:deploy --stage preview
```

Preview, CI, and personal stages use provider simulators. SST prints private proxy, control, dashboard, health, accounting, notification, canary, and telemetry metadata. Private names resolve only from an approved company network connected to the product VPC or from an SST tunnel.

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
PROXY_DOMAIN='proxy.corp.example.com' \
PROXY_CERT_ARN='arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME' \
CONTROL_DOMAIN='proxy-control.corp.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32,198.51.100.0/24' \
pnpm aws:deploy --stage production
```

The domain names above are syntax placeholders and must be replaced. Production rejects missing proxy/control domains, missing proxy certificate, and unspecified source CIDRs. For externally managed control DNS, provide `CONTROL_CERT_ARN` and create the alias yourself. Point the private proxy name at the emitted `loadBalancerHost`.

The proxy NLB terminates TLS on port `8080` for HTTP proxy traffic. The control plane terminates HTTPS on port `443`. SOCKS5 remains unencrypted on port `1080` and is private-network only.

AWS fixes the TLS-listener idle timeout at 350 seconds. V0 fixes the SOCKS5 TCP listener at 1,200 seconds and target-group deregistration at 300 seconds. Proxy-slot load exists only while an upstream connection is active and is heartbeated independently of those load-balancer timeouts.

### Personal SST development

Personal `sst dev` sessions force mock providers and use fixed non-sensitive development placeholders. Start one without provisioning stage secrets:

```sh
pnpm sst:dev --stage alice-dev
```

Application modes with a dev command run locally; SST prints their addresses. This does not deploy the production-shaped Fargate topology. Stop with Ctrl-C and remove persistent stage resources when finished.

SST's VPC tunnel reserves local port `1080`, so `sst dev` runs and advertises the local SOCKS5 listener on `127.0.0.1:1081`. The deployed ECS service uses port `1080`.

In another terminal, copy the printed `integrationTarget` URL and run the black-box lifecycle suite against the local services. It does not read the SST stage or AWS metadata:

```sh
E2E_TARGET_URL='COPY_THE_PRINTED_INTEGRATION_TARGET_URL' pnpm test:e2e
```

```sh
pnpm aws:remove --stage alice-dev
```

## Health and verification

The control plane exposes `/health/live` and `/health/ready`. The accounting and notification services expose the same pair. The dashboard exposes `/health/live`; the public canary exposes `/health/live` and signed `POST /v1/challenge`.

The health aggregator combines:

- provider status/control-plane checks;
- passive outcomes forwarded from normal proxy traffic by the collector;
- optional signed end-to-end requests through a dedicated proxy grant to the isolated canary.

It persists global capabilities `all_traffic`, `managed_sessions`, `stateless_traffic`, and `health_verification` with `operational`, `degraded`, or `unavailable` status. Evidence freshness is reported separately: quiet traffic or a missing synthetic route may make validation stale without declaring an outage.

Aggregator endpoints:

| Endpoint                        | Authentication | Purpose                                 |
| ------------------------------- | -------------- | --------------------------------------- |
| `GET /health/live`              | none           | Process liveness                        |
| `GET /health/ready`             | none           | Refresh/readiness state                 |
| `GET /v1/status`                | health bearer  | Current snapshot                        |
| `POST /v1/passive-signals/otlp` | health bearer  | Collector-filtered passive outcomes     |
| `POST /v1/validate`             | health bearer  | Cooldown-coalesced synthetic validation |

### Configure the synthetic route

The dedicated synthetic profile is disabled in the initial v0 stage policy. After the initial deploy, create a dedicated stateless access grant and retain its proxy URL. Make a reviewed change to `stage.features.syntheticHealthRoute`, store the separated username/token, and redeploy:

```sh
pnpm sst secret set HealthProxyUsername 'ACCESS_GRANT_ID' --stage production
pnpm sst secret set HealthProxyPassword 'ACCESS_GRANT_TOKEN' --stage production

PROXY_DOMAIN='proxy.corp.example.com' \
PROXY_CERT_ARN='arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME' \
CONTROL_DOMAIN='proxy-control.corp.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
pnpm aws:deploy --stage production
```

The canary accepts only short-lived signed, non-replayable challenges. In AWS, API Gateway's `requestContext.http.sourceIp` is authoritative; caller-supplied forwarding headers are ignored.

## Company-facing dashboard

The dashboard root shows 30-day request count, transfer, active upstream connection time, current and time-weighted proxy-slot occupancy, provisioned and unhealthy paid slot capacity, peak and p95 concurrency, attributed cost, capacity recommendations, capability state, freshness, and geography evidence.

The dashboard and its programmatic endpoints are available to authorized users and services across the company, not only the operating team. They are unauthenticated at the application layer in v0, so approved company-network access to the private service is the authorization boundary:

| Endpoint                          | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/status`                 | Latest snapshot plus stale/age fields                                    |
| `GET /api/status/history?limit=N` | Durable capability history                                               |
| `GET /api/status/geographies`     | Latest geography evidence                                                |
| `POST /api/status/validate`       | Proxy a synthetic validation request to the aggregator                   |
| `GET /api/usage`                  | Usage and cost rollups                                                   |
| `GET /api/usage/reconciliations`  | Provider total comparisons and variance evidence                         |
| `GET /api/capacity`               | Slot inventory, compatible capacity, policy, and operator recommendation |

`/api/usage` supports:

- `from` and `to` ISO timestamps;
- `preset=day|week|month`;
- `interval=hour|day|week|month`;
- `groupBy=provider|customer|user|route|job|session_mode|destination_domain|destination_host|destination_path_template|country|city|outcome`;
- `provider=bright_data|proxidize|unresolved`;
- `customerId`, `userId`, `routeId`, `jobId`, `logicalOperationId`, `sessionMode`, `destinationDomain`, `destinationHost`, `destinationPathTemplate`, `country`, `city`, and `outcome` filters.

Example:

```sh
curl -sS \
  'http://127.0.0.1:8083/api/usage?preset=week&interval=day&groupBy=provider'
```

`/api/capacity` accepts optional `country`, `city`, and `carrier` filters. It returns the latest service-private provider-account/slot inventory with current per-slot connection load, compatible healthy and unhealthy capacity, the typed capacity policy, current provider/candidate circuits, and an operator-action recommendation. Slot provisioning remains a manual Proxidize operation in v0. Recommendations are suppressed when geography or carrier inventory is the limiting constraint.

It also returns the typed routing policy and the latest 100 safe routing diagnostics. These diagnostics contain provider, optional provider override and service-private proxy-slot identity, policy version, active-load and soft-pressure evidence, shadow roadmap score components, circuit state/failure class/cooldown, and completion time; they omit caller, route, credential, and destination data. The same policy version and diagnostic components are emitted on restricted selection logs, traces, and the durable attempt ledger.

The initial `proxy-routing-policy-hypotheses-2026-07-18` object holds both the v0 establishment budget and a shadow roadmap scoring hypothesis. V0 selection uses the least active connections within the applicable provider-preference tier and a stable candidate identifier as the tie-breaker. It does not use probabilistic or weighted score selection.

For evidence collection only, the roadmap hypothesis computes a 0–100 score:

`100 × (0.30 reliability + 0.30 headroom + 0.20 performance + 0.15 costEfficiency + 0.05 stability)`

- Reliability is a freshness-adjusted, exponentially weighted success rate over the prior 24 hours with a six-hour half-life. Target HTTP outcomes are excluded.
- Headroom is `max(0, 1 - utilization²)`, where utilization is the maximum of active connections/soft limit, observed/planned Mbps, and projected/prioritized billing-period GiB.
- Performance uses proxy-controlled p95 establishment wait against a 10-second reference.
- Cost efficiency is `1 / (1 + expectedCost/referenceCost)` with a `$0.01` reference and the provider's expected bytes or connection-seconds.
- Stability discounts stale evidence, logical identity churn, and repeated failover.
- Signals without fresh evidence start neutral at `0.5`. The five-point band and `score²` weighting remain roadmap hypotheses and do not control v0 traffic.

Slot claims are durable and liveness-backed. Selection and active-load increment are one atomic operation; connection teardown removes the claim. Candidates at or above the soft limit remain overflow options. Managed sessions exhaust the eligible device-backed class despite soft saturation. For stateless traffic, residential soft saturation promotes compatible unsaturated device-backed capacity ahead of saturated residential overflow. Revalidate and version the roadmap policy's weights, windows, freshness thresholds, normalization references, five-point band, and exponent before allowing it to control production traffic.

The initial `proxidize-capacity-v0-2026-07-17` policy is centralized in code and carried on durable records and rollups:

- 20% headroom;
- 8 planned Mbps per slot, derived from the documented 10 Mbps lower bound at 80%;
- 0.5 assumed Mbps per active connection;
- 16 soft active connections per slot (`8 / 0.5`);
- 50 prioritized GB per slot and billing period.

The dashboard reports recommendation evidence, estimated monthly cost impact, policy version, and evaluation time. Revalidate and version these assumptions when production measurements or provider terms change.

## Usage and cost accounting

The durable usage ledger, not OTLP, is authoritative. Every upstream attempt records an idempotent unsampled event containing logical operation, customer, principal/grant, route, provider, outcome, byte counts, proxy-slot and upstream-connection context, capacity pressure, routing and capacity policy versions, candidate score components, and historical pricing version.

- Bright Data cost is estimated from billable bytes and the historical per-GiB price.
- Proxidize provisioned-slot cost is allocated by customer connection-seconds within each interval. Concurrent customers split proportionally; a slot with no active connection is attributed to `Unallocated`.
- Hour/day/week/month rollups retain group attribution and whether cost is `estimated` or `reconciled`.
- Configured provider totals replace the overall authoritative spend for matching periods.
- Idle slot capacity and unexplained reconciliation differences are posted to the synthetic `Unallocated` customer, never silently prorated to customers. Customer attribution plus `Unallocated` normalizes to reconciled provisioned-slot cost.
- The component provides company-only billing inputs. Invoice generation, approval, adjustments, collection, and customer-facing audit are out of scope.

The initial v0 policy uses empty provider-total and provisioned-capacity inputs. The optional external accounting source is disabled; enabling `stage.features.usageAccountingSource` through a reviewed code change allows a source returning:

```json
{
  "providerTotals": [],
  "provisionedProxySlotCapacity": []
}
```

Protect it with the `UsageAccountingSourceToken` SST secret when enabled.

Each reconciliation persists estimated total, reported total, variance, source version, and `Unallocated` attribution. Default policy:

- ignore relative thresholds until the absolute variance exceeds `$1`;
- warning above `5%`;
- error above `15%`;
- escalate repeated warnings to error.

These thresholds are versioned v0 policy constants. Revisit them through code review using observed data.

Usage accounting owns reconciliation-variance classification and capacity-planning recommendations derived from usage, cost, and capacity rollups. It persists idempotent warning/error events before emitting aggregate logs. Authorized dashboard users can inspect those non-capability events through the private `GET /api/usage/events` endpoint. Events contain only the period, provider, related rollup or reconciliation ID, policy/constraint evidence, aggregate failure/fallback/wait counts, and aggregate variance; they do not include credentials, destinations, customers, routes, or proxy-slot identifiers.

Capacity pressure is also persisted as normalized evidence through the shared service contract and is available at `GET /api/usage/capacity-pressure-evidence`. The health aggregator reads fresh evidence (five minutes by default, configurable with `HEALTH_CAPACITY_PRESSURE_MAX_AGE_MS`) and alone classifies the affected capability as degraded. Usage accounting does not classify capability state or emit capability alerts.

## Alerting

The health aggregator owns capability-state classification, capability alerts, and recovery events in v0, including `degraded` states supported by fresh capacity-pressure evidence. `unavailable` alerts are immediate. `degraded` alerts wait five minutes by default. An alerted capability emits one recovery when it returns to `operational`. Geography is context on global events, not a separate subscription.

Signed HTTPS webhooks are disabled in the initial v0 stage policy. To enable them, make a reviewed change to `stage.features.healthAlerting` and configure one versioned secret:

```sh
pnpm sst secret set HealthAlertDestinations \
  '{"version":"2026-07-15","destinations":[{"id":"primary-ops","url":"https://alerts.example.com/profound","secret":"REPLACE_WITH_A_LONG_SIGNING_SECRET"}]}' \
  --stage staging

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

High-cardinality route, grant, user, proxy-slot, peer, device, session, and IP identifiers stay out of metric attributes. Proxy-slot identifiers are permitted only in restricted logs, traces, inventory diagnostics, and connection-level usage records. Public-canary access/security events share the log dataset with `log.category=security`.

## Release and connection draining

GitHub Actions builds an immutable image once and promotes the same digest through environments. The proxy uses ECS native blue/green target groups. Established HTTP requests and HTTPS/SOCKS5 tunnels write durable active-connection records so a retiring deployment can drain safely and slot load remains shared across tasks.

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

1. Confirm the username is the opaque credential username, not a profile, grant, customer, or provider identifier.
2. Check credential `expiresAt`, `revokeAt`, and grant/route status through the control plane.
3. Confirm URL encoding was preserved when a proxy URL was split into username/password fields.
4. Rotate routinely if in the renewal window; emergency-rotate if disclosure is possible.
5. Remember that a secret cannot be retrieved after issuance.

### Provider unavailable or route creation fails

1. Read the provider-neutral error and use the company-facing status/dashboard diagnostics for provider health and capacity.
2. Compare the profile's geography, carrier, target-authenticated intent, and retry intent with restricted capability evidence.
3. For authenticated routes, confirm an exact-city-capable provider is available.
4. Check compatible proxy-slot inventory, health, current connection load, and capacity pressure for Proxidize.
5. Keep provider selection and provider diagnostics out of public requests and responses; use only authorized company-facing dashboard and telemetry views to explain eligibility.

### Health is stale but not unavailable

1. Check the provider refresh timestamp.
2. Confirm passive-health OTLP records reach the aggregator.
3. Confirm the synthetic grant exists and can reach the signed canary.
4. Distinguish quiet traffic from a failed signal path before paging.

### Reconciliation variance is warning/error

1. Verify provider total period boundaries and source version.
2. Confirm historical price versions, bytes, connection-seconds, and provisioned-slot intervals.
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

After recovery or an ECS replacement, verify route authentication, access-grant metadata, provider inventory, active slot-load records, provider/capability state, accounting rollups, capacity-policy versions, and alert delivery before reopening traffic.

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
- The black-box E2E suite and AWS acceptance suite have passed for the immutable release image.
- Repository protection and OIDC settings match [repository-and-release-settings.md](repository-and-release-settings.md).
