# Profound Proxy Router

A provider-neutral HTTP/HTTPS and SOCKS5 proxy gateway over Bright Data residential proxies and Proxidize mobile proxies. Existing proxy-aware clients keep their original destination URL, method, headers, query string, body, redirect behavior, TLS behavior, and tunneled payloads; migration normally means changing only the configured proxy endpoint and credentials.

An authenticated control plane creates reusable, secret-free route profiles and per-principal access grants. Each grant receives its own one-time proxy credential, so users and services can independently rotate or revoke access to the same profile. Credentials expire after 30 days; their metadata exposes a renewal reminder seven days before expiration. The HTTP data plane uses absolute-form requests for plain HTTP and opaque `CONNECT` tunnels for HTTPS. A separate SOCKS5 listener supports username/password authentication and TCP `CONNECT`; `BIND` and `UDP ASSOCIATE` are rejected. Provider endpoints and vendor credentials never leave the service.

The default `mock` mode starts local simulations of both provider contracts and requires no vendor account, credentials, or payment.

## Requirements

- Node.js 22.13 or newer
- TypeScript 7
- pnpm 10
- Docker and AWS credentials for AWS deployments

## Install

Installing dependencies does not start the service:

```sh
pnpm install
pnpm sst install
```

The second command installs SST's generated infrastructure providers and types. Neither command starts the service.

## Start locally

```sh
pnpm dev
```

The HTTP/HTTPS forward proxy listens on `127.0.0.1:8080`, SOCKS5 listens on `127.0.0.1:1080`, and the control API listens on `127.0.0.1:8081`. Local mock mode bound to loopback defaults to the development control token `change-me` and trusted user ID `local-dev`.

- OpenAPI 3.1 JSON: `http://127.0.0.1:8081/openapi.json`
- Swagger UI: `http://127.0.0.1:8081/docs`

The control plane is defined once with Effect HttpApi schemas. The running service exposes that language-neutral contract at `/openapi.json`, and the same version is committed as `openapi/profound-control-api.v0.5.0.json` for client and SDK generation. OpenAPI intentionally covers management operations only: HTTP/HTTPS forwarding and SOCKS5 remain native proxy protocols.

After changing a control-plane schema, run `pnpm openapi:generate` and commit the updated artifact. `pnpm openapi:check` verifies that the committed file is current. CI also compares it with the pull request base contract, rejects incompatible removals or newly required inputs, and publishes the validated contract as a build artifact.
- Liveness: `http://127.0.0.1:8081/health/live`
- Readiness: `http://127.0.0.1:8081/health/ready`

Create a route for unauthenticated public-data traffic:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "public-us",
    "allowedProtocols": ["http", "https", "socks5"],
    "targeting": { "country": "US", "postalCode": "10001" },
    "customerId": "customer-a",
    "isAuthenticated": false,
    "shouldRetry": true
  }'
```

The response returns the reusable `route`, the caller's initial `accessGrant`, its redacted `credential` metadata, and `proxyUrls.http`/`proxyUrls.socks5` once. The proxy username is the access-grant ID, not the route ID; the password is shown only at grant issuance or credential rotation and is stored only as a non-retrievable verifier. Configure the corresponding endpoint in the client that previously used a vendor proxy:

Access-grant credentials are bearer secrets. V0 attributes their use to the grant owner but cannot prevent that owner from deliberately sharing the credential; identity-bound data-plane authentication such as mTLS is deferred.

```sh
curl --proxy 'http://ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN@127.0.0.1:8080' https://example.com/
```

That command sends `CONNECT example.com:443` to Profound. Profound opens the corresponding provider tunnel and then relays encrypted bytes; it does not see or modify the inner HTTPS path, headers, query, body, redirect, or status.

The same credentials work on the SOCKS5 listener:

```sh
curl --socks5-hostname '127.0.0.1:1080' \
  --proxy-user 'ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN' \
  https://example.com/
```

`--socks5-hostname` preserves the destination domain in the SOCKS5 request so the selected upstream provider performs DNS resolution in its own geography. SOCKS5 traffic is an opaque TCP tunnel; the gateway does not inspect the tunneled HTTP/TLS payload.

The health components are separate processes. For local development, run these in additional terminals with one shared signing secret and SQLite path:

```sh
SERVICE_MODE=canary CANARY_SIGNING_SECRET=local-canary-secret pnpm dev

SERVICE_MODE=health-aggregator \
HEALTH_AGGREGATOR_TOKEN=local-health-secret \
CANARY_SIGNING_SECRET=local-canary-secret \
HEALTH_CANARY_URL=http://127.0.0.1:8090/v1/challenge \
pnpm dev

SERVICE_MODE=status \
HEALTH_AGGREGATOR_TOKEN=local-health-secret \
HEALTH_AGGREGATOR_URL=http://127.0.0.1:8082 \
pnpm dev

SERVICE_MODE=notification \
HEALTH_ALERT_DESTINATIONS_JSON='{"version":"local","destinations":[]}' \
pnpm dev
```

The local status page is then available at `http://127.0.0.1:8083/`. A dedicated health access-grant ID/token may be supplied as `HEALTH_PROXY_USERNAME` and `HEALTH_PROXY_PASSWORD` with `HEALTH_PROXY_URL=http://127.0.0.1:8080` to enable proxied synthetic validation.

The canary always returns the connection source IP. Without a local GeoLite2 City MMDB it also returns `geo.status: "unavailable"`. To exercise the full local geography path, set `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY`; the canary downloads the current GeoLite2 City MMDB into `GEOIP_DATABASE_PATH`, validates it before activation, and then checks for a new build every 3.5 days.

## Deploy to AWS with SST

The root SST config selects a provider-specific deployment module; AWS is the only implemented provider in v0. Its module deploys separate ECS Fargate services for the proxy data plane, control plane, health aggregator, status application, notification worker, and product telemetry collector. A second telemetry-collector service runs in the isolated canary VPC. The proxy uses an internal Network Load Balancer; control, status, notification, and aggregation ingress are also internal. ECS keeps a capacity-provider migration path to ECS Managed Instances or self-managed EC2 if measured cost or sustained throughput later justifies instance-backed capacity.

The public canary is an API Gateway HTTP API backed by Lambda in the isolated canary VPC. API Gateway supplies the authoritative connection source address; the function does not trust caller-supplied forwarding headers. The versioned GeoLite2 City MMDB is packaged with the Lambda deployable, and the function has no provider credentials, customer data, internal routes, or network access to the product VPC. Route profiles, access-grant verifier hashes, grant-scoped mobile device leases, provider health, capability-history snapshots, alert episodes, and notification deliveries live in an on-demand DynamoDB table with point-in-time recovery.

Applications send backend-neutral OTLP to the pinned ADOT collector service in their VPC; the collectors batch, queue, retry, filter, and export to Axiom. Logs, traces, and metrics use three dedicated OpenTelemetry datasets. Public-canary security/access events use a filtered log stream and `log.category=security` within the shared log dataset. All three telemetry datasets retain for 30 days by default, recorded by `TELEMETRY_RETENTION_DAYS`. ECS stderr and Lambda stderr remain error-only bootstrap/exporter fallbacks, not the canonical telemetry path. Each component has an independent runtime identity and health boundary.

Install dependencies, make sure Docker is running, and verify that the active AWS identity is the intended account:

```sh
pnpm install
aws sts get-caller-identity
```

Before deploying, create three Axiom datasets as described in Axiom's [OpenTelemetry guide](https://axiom.co/docs/send-data/opentelemetry): a **Logs + Traces** event dataset for logs, another **Logs + Traces** event dataset for traces, and a **Metrics** dataset. The default names are `profound-proxy-router-<stage>-logs`, `profound-proxy-router-<stage>-traces`, and `profound-proxy-router-<stage>-metrics`. Set all three datasets to `TELEMETRY_RETENTION_DAYS`, which defaults to 30. Axiom also supports managing dataset kind and retention through its [Terraform provider](https://axiom.co/docs/apps/terraform), if that is already part of your platform stack.

Create an Axiom API token scoped to ingest into those datasets. Store it as an SST secret; the token is injected only into the two collector services and is not present in application containers or the canary Lambda. Override `AXIOM_OTLP_ENDPOINT` and the three `AXIOM_*_DATASET` variables at deploy time when using non-default names or an Axiom edge deployment.

Every deployed stage needs separate Axiom-ingestion, control-plane, health-aggregator, and canary-signing credentials:

```sh
pnpm sst secret set AxiomIngestToken 'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage staging
pnpm sst secret set ControlApiToken 'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage staging
pnpm sst secret set HealthAggregatorToken 'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage staging
pnpm sst secret set CanarySigningSecret 'REPLACE_WITH_A_SIGNING_SECRET' --stage staging
```

`ControlApiToken` represents one trusted service principal. To authorize multiple users or service principals in v0, store a token-to-principal map only in the control-plane secret and deploy with the feature flag:

```sh
pnpm sst secret set ControlApiIdentities \
  '{"TOKEN_FOR_USER_ONE":"user-one","TOKEN_FOR_SERVICE_TWO":"service-two"}' \
  --stage staging

CONTROL_API_IDENTITIES_CONFIGURED=true pnpm aws:deploy --stage staging
```

When configured, `ControlApiIdentities` is the complete accepted identity set and replaces the single `ControlApiToken` identity; include every principal that must retain access.

The control plane derives the grant owner from that trusted bearer claim; callers cannot choose `principalId` in route or access-grant payloads.

Prepare the versioned GeoIP bundle before each deployment. Run this at least twice weekly in the deployment pipeline; it uses an authenticated HEAD check, downloads only a newer build, validates the archive shape, and atomically stages the MMDB plus metadata under `.sst/geoip`:

```sh
MAXMIND_ACCOUNT_ID='MAXMIND_ACCOUNT_ID' \
MAXMIND_LICENSE_KEY='MAXMIND_LICENSE_KEY' \
pnpm geoip:prepare
```

Operator webhooks are optional versioned configuration. Enable them by storing the complete destination set as one secret and deploying with the feature flag:

```sh
pnpm sst secret set HealthAlertDestinations \
  '{"version":"2026-07-15","destinations":[{"id":"primary-ops","url":"https://alerts.example.com/profound","secret":"REPLACE_WITH_A_LONG_SIGNING_SECRET"}]}' \
  --stage staging

HEALTH_ALERTING_CONFIGURED=true \
HEALTH_ALERT_CONFIGURATION_VERSION='2026-07-15' \
HEALTH_ALERT_DESTINATION_IDS='primary-ops' \
pnpm aws:deploy --stage staging
```

Destination URLs must use HTTPS. Each webhook contains `x-profound-event-id`, `x-profound-timestamp`, and `x-profound-signature`; the signature is `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw JSON body>`. Delivery failure is retried with exponential backoff and recorded durably without changing the evaluated health state.

To run the application service modes locally while using a `dev` stage for AWS-backed state and IAM, create the control, health, signing, and ingestion secrets for that stage and start SST dev. GeoIP is optional in local SST dev because an absent database has explicit `unavailable` semantics:

```sh
pnpm sst secret set ControlApiToken 'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage dev
pnpm sst secret set HealthAggregatorToken 'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage dev
pnpm sst secret set CanarySigningSecret 'REPLACE_WITH_A_SIGNING_SECRET' --stage dev
pnpm sst secret set AxiomIngestToken 'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage dev
pnpm sst:dev --stage dev
```

In SST dev mode, application services with a `dev` command run locally on the loopback ports documented above. The control
API uses the local-only `change-me` token. SST prints localhost URLs; it does not
deploy the production Fargate application topology until `sst deploy`. Stop the session
with Ctrl-C, and remove its persistent dev-stage AWS resources when finished with
`pnpm aws:remove --stage dev`.

Deploying a non-production stage uses the local provider simulators by default. It is useful for verifying the AWS infrastructure without vendor traffic:

```sh
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
pnpm aws:deploy --stage staging
```

The deploy prints the internal proxy and control endpoints plus `statusApplication`, `healthAggregator`, `publicCanary`, `telemetryBackend`, and `axiomDatasets`. The proxy, control, status, notification, and aggregator URLs resolve only through the product VPC; the canary API is intentionally public and accepts only short-lived signed challenges. Without `PROXY_DOMAIN`, a non-production stage uses the generated internal proxy load-balancer hostname and plain TCP.

For a live production stage, set the vendor values first:

```sh
pnpm sst secret set BrightDataCustomerId 'CUSTOMER_ID' --stage production
pnpm sst secret set BrightDataZone 'ZONE' --stage production
pnpm sst secret set BrightDataPassword 'PASSWORD' --stage production
pnpm sst secret set BrightDataApiKey 'API_KEY' --stage production
pnpm sst secret set ProxidizeApiToken 'TOKEN' --stage production
pnpm sst secret set AxiomIngestToken 'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage production
pnpm sst secret set ControlApiToken 'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage production
pnpm sst secret set HealthAggregatorToken 'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage production
pnpm sst secret set CanarySigningSecret 'REPLACE_WITH_A_SIGNING_SECRET' --stage production
```

Production requires internal proxy and control domains plus explicit source CIDRs. If the names are in Route 53, SST creates and validates the certificates and DNS aliases:

```sh
PROVIDER_MODE=live \
PROXY_DOMAIN='proxy.example.com' \
CONTROL_DOMAIN='proxy-control.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32,198.51.100.0/24' \
MIN_TASKS=2 \
MAX_TASKS=4 \
pnpm aws:deploy --stage production
```

For DNS hosted elsewhere, also pass `PROXY_CERT_ARN` and `CONTROL_CERT_ARN` for already validated ACM certificates and point the names at their internal load balancers yourself.

The internal NLB terminates TLS on port `8080` for the HTTP/HTTPS forward proxy. The separate internal control load balancer terminates HTTPS on port `443`. Generated forward-proxy URLs therefore start with `https://`; that TLS protects the access-grant credential between the client and Profound, while a target HTTPS session remains a separate opaque `CONNECT` tunnel. SOCKS5 remains standard unencrypted SOCKS5 on port `1080`, so use it only through the trusted private network. AWS fixes TLS-listener idle timeout at 350 seconds; the configurable SOCKS5 TCP-listener timeout defaults to 1,200 seconds. Deregistration draining defaults to 300 seconds. Override the configurable values with `NLB_TCP_IDLE_TIMEOUT_SECONDS` and `NLB_DEREGISTRATION_DELAY_SECONDS`. These transport settings are explicit and independent of the logical 15-minute idle lease.

The proxy data-plane service defaults to two production tasks and can scale to four. Non-production stages default to one proxy task and can scale to two. Override those data-plane limits with `MIN_TASKS` and `MAX_TASKS`; the supporting services use their own fixed minimums. These resources incur AWS charges. Remove a disposable stage with `pnpm aws:remove --stage staging`; the production stage and production DynamoDB table are protected from accidental deletion.

### Capability status and verification

The status application reports only `All Traffic`, `Authenticated Traffic`, `Unauthenticated Traffic`, and `Health Verification`. Each capability has an `operational`, `degraded`, or `unavailable` state plus separate provider-status and end-to-end-validation timestamps. A healthy preferred provider class remains operational even if a fallback class is unhealthy; loss of the preferred class is degraded while an eligible fallback remains and unavailable only when no eligible provider remains. Quiet traffic may make validation stale without turning the capability into an outage. Geography evidence and bounded snapshot history are available from `/api/status/geographies` and `/api/status/history`; `POST /api/status/validate` requests a fresh validation through the internal aggregator.

The health aggregator polls provider status—including Bright Data's documented [`GET /network_status/res`](https://docs.brightdata.com/api-reference/account-management-api/Get_current_service_status)—and accepts passive outcomes from the product telemetry collector as OTLP JSON at `POST /v1/passive-signals/otlp`. The collector keeps all telemetry flowing to Axiom while filtering and fanning out only the `profound.proxy.passive_health` records to the aggregator. Recent passive traffic counts as validation. Synthetic checks run only after a provider/passive conflict or an explicit validation request, share one configurable five-minute cooldown, and coalesce concurrent requests. Axiom receives raw evidence and finalized states for investigation but does not evaluate capability state or trigger signed synthetic checks. A short-lived signed challenge is attempted through the normal proxy path; after a proxy failure, a direct request to the canary is used only as a control. A proxy-only failure degrades the affected capability, two failures are inconclusive, and one synthetic result never makes traffic unavailable without provider or passive corroboration. Canary failure affects `Health Verification`, not proxy-traffic availability.

The canary resolves only the observed connection source IP against its local MaxMind GeoLite2 City MMDB; it is not an arbitrary-IP lookup API. It returns the raw IP, approximate country/subdivision/city, GeoName ID, accuracy radius, dataset build metadata, timestamp, and correlation ID. Missing data or an accuracy radius above `GEOIP_MAX_ACCURACY_RADIUS_KM` (100 km by default) is `unverifiable`, not a mismatch. Dataset or lookup failure leaves the raw IP intact and returns `geo.status: "unavailable"`.

In AWS, the Lambda handler uses API Gateway's `requestContext.http.sourceIp` as authoritative connection metadata and ignores caller-supplied forwarding headers. The deployment pipeline runs `pnpm geoip:prepare` at least twice weekly, checks the remote build with an authenticated HEAD request, validates a newer archive, atomically stages the MMDB and version metadata, and packages both files with the Lambda deployable.

Synthetic proxy checks need a dedicated access grant. After the first deploy, create an unauthenticated health route profile, store its returned access-grant ID/token, then redeploy with the optional grant enabled:

```sh
pnpm sst secret set HealthProxyUsername 'ACCESS_GRANT_ID' --stage production
pnpm sst secret set HealthProxyPassword 'ACCESS_GRANT_TOKEN' --stage production

HEALTH_SYNTHETIC_ROUTE_CONFIGURED=true \
PROVIDER_MODE=live \
PROXY_DOMAIN='proxy.example.com' \
CONTROL_DOMAIN='proxy-control.example.com' \
CONTROL_PLANE_ALLOWED_CIDRS='203.0.113.10/32' \
DATA_PLANE_ALLOWED_CIDRS='203.0.113.10/32,198.51.100.0/24' \
pnpm aws:deploy --stage production
```

Without those optional route secrets, provider and passive health still work and `Health Verification` reports that no synthetic validation has run.

### Alerting

The aggregator creates durable events only after a global capability snapshot is finalized. `unavailable` alerts are immediate; `degraded` alerts wait five minutes by default (`HEALTH_ALERT_DEGRADED_DELAY_MS`); an alerted capability emits one recovery when it returns to `operational`. Geography observations are context on global events, not independent subscriptions. Stale or conflicting evidence is exported as lower-severity telemetry. Finalized alerts and delivery outcomes are structured OTLP log events, so a central platform can consume them alongside snapshots.

Capability-health and recovery alert ownership is fixed to the health aggregator for v0; setting `HEALTH_ALERT_RULE_OWNER` to anything other than `service` is rejected. Axiom monitors may own separate non-capability engineering alerts such as telemetry-ingestion gaps, unusual usage, or diagnostic performance trends. Destination configuration is operator-owned and versioned for v0; team/user and independent-geography subscriptions are deferred.

For persistent authenticated collection, create a mobile-compatible route:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "authenticated-ny",
    "targeting": { "country": "US", "region": "NY", "city": "New York", "carrier": "T-Mobile" },
    "rotation": { "mode": "manual" },
    "session": {
      "mode": "sticky",
      "id": "caller-session-42",
      "requireGeographicContinuity": true
    },
    "customerId": "customer-a",
    "isAuthenticated": true,
    "shouldRetry": false
  }'
```

`forceProvider` (`bright_data` or `proxidize`) is an optional debugging/rollout override; an incompatible or unavailable forced provider fails without automatic fallback.

Authenticated routes must include `targeting.city`. Every attempted peer, device, and provider must guarantee that city or verify it before the connection is exposed. Mock Proxidize inventory is marked `provider_guaranteed`. Live Proxidize defaults to `unsupported` for authenticated exact-city routing. Operators may set `PROXIDIZE_EXACT_CITY_SUPPORT=provider_guaranteed` only after establishing that vendor guarantee; the external canary's post-connection GeoLite2 evidence does not satisfy a pre-commit exact-city guarantee.

`allowedProtocols` is optional and defaults to `http`, `https`, and `socks5`. Restrict it when grants for a profile should be usable on only selected data-plane protocols. The listener/handshake determines the actual protocol; callers do not send a service-specific metadata envelope.

## Control-plane authentication

`CONTROL_API_TOKEN` protects route-profile creation, inspection, rotation, revocation, access-grant lifecycle, provider capabilities, and provider health. It is necessary because those operations issue and manage credentials that authorize proxy use; it is independent of the target site’s authorization and of vendor proxy credentials. `CONTROL_API_USER_ID` is the trusted principal claim used for grant ownership and telemetry. For multiple callers, `CONTROL_API_IDENTITIES_JSON` maps each bearer token to its trusted principal ID. Any authenticated internal user may supply any free-form `customerId` in this initial version.

Live mode and non-loopback control bindings reject the local placeholder token.

Access-grant credentials are opaque references to both their owner grant and the current server-side route profile. Every new request or tunnel resolves both records, so grant revocation, route revocation, and expiration apply without embedding policy or vendor credentials in the token. Credentials have a fixed 30-day lifetime with no idle extension. Redacted metadata includes credential ID, status, creation, renewal-due, expiration, overlap-revocation, and last-use timestamps. Each secret is revealed only in its issuance or rotation response and is never returned afterward. Routine grant or route revocation blocks new connections but leaves established requests and tunnels running. Their corresponding `emergency-revoke` endpoints are explicit security kill switches; a grant emergency affects only that grant, while a route emergency affects every grant for the profile.

## Routing, retry, and session behavior

- Unauthenticated routes try every compatible residential provider before every compatible device-backed provider. With the initial adapters, that means Bright Data before Proxidize.
- Authenticated routes try every compatible device-backed provider before every compatible residential provider. With the initial adapters, that means an exact-city-capable Proxidize route before Bright Data. Authentication is caller-supplied metadata and does not itself make either provider ineligible.
- Within a provider class, the current provider is tried first and remaining providers use cost rank. Failover exhausts up to two peers or devices in the selected provider before moving to another compatible provider, and considers at most three providers. `forceProvider` still allows alternate peers inside that provider but prohibits cross-provider fallback.
- A provider and candidate are eligible only when operational, within capacity, and compatible with the route's protocol, geography, carrier, session, rotation, and target-port requirements.
- Exact device or IP continuity is not required during failover. Authenticated attempts may move to another device or provider only when the route's exact city and every other bound capability remain satisfied.
- Plain HTTP bodies stream with backpressure. The initial implementation never retries after application request bytes have reached an upstream proxy. Target HTTP statuses—including `429` and `5xx`—and provider-authentication failures are returned or normalized without failover.
- HTTPS and SOCKS5 application data are opaque tunnels. Only failures before a successful `CONNECT` can be retried; after establishment, retries and redirects belong to the client.
- `shouldRetry` is required. Optional `retryPolicy.maxAttempts` (maximum 6) overrides the central default. The gateway performs no in-request backoff. With the two initial providers, the default is four attempts: at most two per provider.
- Route affinity may persist independently of target-site session state. The gateway never inspects target cookies or bodies. Every device-backed candidate is exclusively leased within one access grant; the lease key combines that grant with `session.id` when supplied and otherwise uses the grant alone. Users of the same route profile therefore do not share device state, and rotating the grant credential preserves its lease. Activity renews the durable lease. It has no absolute lifetime cap and is released only explicitly or after a service-wide 15-minute interval with no active connection or recent activity. A failed candidate may be replaced while all route constraints and exclusive ownership remain satisfied. The reliability of Proxidize's IP field for the next connection remains unresolved.
- Each candidate establishment attempt has at most 10 seconds, and the complete establishment sequence has at most 30 seconds. The attempt budget includes provider control calls, health/capability selection, provider-side DNS and connection setup, and proxy/tunnel negotiation. Best-effort local DNS observation runs outside the routing critical path. Successful responses and tunnels are not limited by these establishment deadlines.
- Bright Data requests use a service-generated constant session for each selected candidate. Per-request routes receive a new session on every logical request, while interval/manual routes retain their primary session until service-controlled rotation. Proxidize automatic rotation is disabled; interval rotation is claimed in shared route state and initiated by the service.

Authorized principals can inspect the secret-free profile with `GET /v1/routes/:id`, mint their own grant with `POST /v1/routes/:id/access-grants`, and list only their redacted grants and credential metadata with `GET /v1/routes/:id/access-grants`. Automation should rotate during the seven-day renewal window using `POST /v1/access-grants/:grantId/credentials/rotate`; the old credential remains valid for at most 72 hours or until its original expiration, and the service enforces that revocation deadline. This keeps the grant ID and mobile lease. For suspected compromise, `POST /v1/access-grants/:grantId/credentials/emergency-rotate` invalidates every prior credential immediately while issuing a replacement. Revoke the grant idempotently with `DELETE /v1/access-grants/:grantId`, emergency-revoke it with `POST /v1/access-grants/:grantId/emergency-revoke`, or release its device lease with `POST /v1/access-grants/:grantId/release`. Rotate an exit with `POST /v1/routes/:id/rotate`. Provider class, capability, versioned pricing, DNS-resolution, and usage-dimension descriptors are available from `GET /v1/providers`; health is at `GET /v1/providers/health`.

## Streaming and security

- HTTP request/response bodies, HTTP CONNECT traffic, and SOCKS5 CONNECT traffic stream with backpressure and per-direction byte accounting. There are no application-level 10 MiB/50 MiB full-buffer limits.
- HTTP header size, SOCKS5 handshake size, per-attempt establishment timeout, overall establishment timeout, and tunnel idle safeguards are centralized with `MAX_HEADER_BYTES`, `CONNECT_TIMEOUT_MS` (maximum 10,000), `OPERATION_TIMEOUT_MS` (maximum 30,000), and `STREAM_IDLE_TIMEOUT_MS`.
- Only public-Internet HTTP/S and SOCKS5 TCP-CONNECT targets are allowed. Explicit loopback, private, link-local, multicast, reserved, cloud-metadata, and special-use IP literals are rejected before routing. Domain names are preserved for provider-side resolution; local DNS is best-effort telemetry only and cannot reject, redirect, or delay an otherwise valid operation.
- Target ports default to `80,443`; deliberate public-port exceptions use `ALLOWED_TARGET_PORTS` for both listeners.
- Plain HTTP redirects are forwarded unchanged. HTTPS and SOCKS5 redirects are opaque. The client decides whether to follow them, creating a new independently validated proxy operation.
- Target URL credentials are rejected. Target headers and bodies are forwarded but omitted from logs and traces. Query strings, access-grant tokens, provider credentials, cookies, authorization values, and unsanitized exception text are also omitted.
- Target traffic never falls back to a direct, non-proxied connection. HTTP absolute-form requests and HTTP/SOCKS5 tunnels preserve domain targets for resolution at the selected provider. When an adapter exposes the provider-resolved destination, traces and structured logs record its normalized addresses alongside best-effort local results, divergence, and verification availability. Public divergence is diagnostic; private or special-purpose observations and claimed-geography mismatches produce warnings. Opaque provider resolution retains the documented v0 rebinding risk rather than silently switching to local resolution.

## Verification

```sh
pnpm check
pnpm test
pnpm build
```

Normal tests use local provider and target simulations. `pnpm test:live` remains skipped unless `RUN_LIVE_PROXY_TESTS=1` and vendor credentials are supplied.

### Comprehensive deployed integration suite

`pnpm test:deployed` runs the controlled offline specification tests and then exercises an actual deployed SST stage. Through an SST tunnel it calls the internal control, HTTP proxy, SOCKS5, status, and health endpoints; it calls the public canary API directly. It inspects ECS, Lambda, API Gateway, IAM identities, VPCs, load balancers, and DynamoDB through AWS APIs, and queries the stage's dedicated Axiom datasets to verify OTLP logs, metrics, traces, retention, and security-log categorization. It does not substitute local simulators for the deployed services.

Create a disposable non-production stage with the isolated test origin enabled. The origin is deployed in the canary VPC, has no route into the product VPC, and is rejected by the SST configuration for `production`:

```sh
pnpm sst secret set AxiomIngestToken 'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage integration
pnpm sst secret set ControlApiToken 'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage integration
pnpm sst secret set HealthAggregatorToken 'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage integration
pnpm sst secret set CanarySigningSecret 'REPLACE_WITH_A_SIGNING_SECRET' --stage integration

DEPLOY_INTEGRATION_TARGET=true \
pnpm aws:deploy --stage integration
```

In another terminal, connect the runner to the stage VPC so every internal service remains private while still being testable:

```sh
pnpm sst tunnel --stage integration
```

Then run the suite with the same stage secrets plus a query-scoped Axiom token. The test runner discovers non-secret URLs, ECS names, table names, and dataset names from `/sst/profound-proxy-router/integration/deployed-integration` in SSM Parameter Store:

```sh
DEPLOYED_STAGE=integration \
DEPLOYED_CONTROL_API_TOKEN='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_HEALTH_AGGREGATOR_TOKEN='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_CANARY_SIGNING_SECRET='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_AXIOM_QUERY_TOKEN='AXIOM_DATASET_SCOPED_QUERY_TOKEN' \
DEPLOYED_RUN_DISRUPTIVE_TESTS=1 \
pnpm test:deployed
```

The disruptive flag verifies DynamoDB-backed access-grant credentials and grant-scoped mobile affinity across a forced proxy ECS replacement; omit it for the non-disruptive suite. The TLS tunnel check defaults to `https://example.com/` and can use a controlled HTTPS origin via `DEPLOYED_HTTPS_TARGET_URL`. The suite expects the documented 30-day telemetry default; when intentionally testing a different policy, set `DEPLOYED_EXPECTED_TELEMETRY_RETENTION_DAYS` to the deployed value. The requirements-to-assertion inventory is versioned with the tests in `tests/deployed/spec-matrix.ts`; unresolved design questions are marked deferred instead of being silently treated as requirements.

Remove the disposable stage when finished:

```sh
pnpm aws:remove --stage integration
```

## Live mode

Set `PROVIDER_MODE=live`, configure a strong control token and trusted user ID, and provide the Bright Data and Proxidize settings in `.env.example`. Live adapters use documented endpoints but remain credential-unverified until vendor accounts are available.

## OpenTelemetry

The service distinguishes each client plain HTTP request, HTTPS HTTP-CONNECT tunnel, or SOCKS5 CONNECT tunnel from every upstream provider attempt. Per-attempt spans and structured logs include provider, logical operation ID, attempt ID, outcome, latency, retry/failover context, bytes sent/received, normalized candidate/session/device evidence, expected and observed city, verification source, assignment mode, candidate-change reason, whether provider reassignment was disabled, and normalized local/provider destination-resolution evidence with divergence and verification availability. Allowlisted provider identity metadata such as `x-brd-ip` is retained; raw provider headers are not. Plain HTTP may also include target method, host, and status; tunnel records include only data-plane protocol, target host/port, establishment outcome, duration, and byte counts—never inner application metadata.

User and customer IDs are trace/log fields, while byte counts and candidate identifiers remain span/log fields rather than metric attributes. Aggregate metrics cover operation and attempt volume, duration, errors, rotations, normalized candidate-change reasons, and geographic-verification outcomes. v0 uses an explicit always-on trace sampler and exports every trace for retention; metrics and usage records are also unsampled. Any future reduction must be outcome-aware and retain failures, retries, failovers, slow operations, synthetic checks, and alerts. The Effect runtime is bridged through `@effect/opentelemetry`, and standard OTLP exporters remain configurable:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_TRACES_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_LOGS_EXPORTER=otlp \
pnpm dev
```

In a deployed SST stage, each application sends OTLP over loopback to its task-local ADOT Collector. The collector uses queued, retried OTLP/HTTP exporters with the secret `AxiomIngestToken`: operational logs and filtered public-canary security events go to `AXIOM_LOGS_DATASET`, traces to `AXIOM_TRACES_DATASET`, and metrics to `AXIOM_METRICS_DATASET`. Security events remain identifiable by `log.category=security`. The proxy collector also sends only passive-health log records to the internal health aggregator. Application logs use OpenTelemetry as the canonical path; stderr is retained only for error-level bootstrap and exporter failures so ECS still has a last-resort diagnostic channel.

Metric attributes intentionally exclude route, access-grant, user, peer, device, session, and IP identifiers. Those high-cardinality values are limited to redacted logs and spans. Request/response bodies, raw headers, query strings, cookies, provider credentials, access-grant tokens, and administrator tokens are never emitted.
