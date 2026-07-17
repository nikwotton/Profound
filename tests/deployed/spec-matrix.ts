export const DESIGN_DOCUMENT_ID = "1Ud9m_c7YEYxjXS2QOiuCAKYMT5WVGzuN5oshEbm5zfU";
export const DESIGN_DOCUMENT_REVISION =
  "ALtnJHzS0Fg7V5rLhZMZRHkGXwk92af1s8LcaaZWCJ2o5lMH86MzdV_Lesl3xhswzeolZ58c-LZXftFrSZYV1byv6X0bV1xfpimm5VMYbXs";

export interface SpecCoverage {
  id: string;
  section: number;
  requirement: string;
  deployed: readonly string[];
  offline: readonly string[];
  deferred?: true;
}

export const SPEC_COVERAGE: readonly SpecCoverage[] = [
  {
    id: "1.provider-neutral",
    section: 1,
    requirement: "Provider-neutral service credentials and adapter-hidden vendor details",
    deployed: [
      "deployed control plane exposes liveness, readiness, OpenAPI, providers, and health",
      "deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles",
    ],
    offline: [],
  },
  {
    id: "2.protocol-preservation",
    section: 2,
    requirement: "Standard HTTP forward proxy, HTTP CONNECT, and authenticated SOCKS5 CONNECT preserve caller behavior",
    deployed: [
      "deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body",
      "deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic",
    ],
    offline: [],
  },
  {
    id: "2.no-tls-interception",
    section: 2,
    requirement: "No TLS interception or post-CONNECT inspection",
    deployed: ["deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic"],
    offline: ["HTTPS CONNECT tunnels bytes through the selected provider"],
  },
  {
    id: "2.no-fetch-envelope",
    section: 2,
    requirement: "No application-specific fetch API or service envelope",
    deployed: ["deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body"],
    offline: ["Effect generates a complete secured OpenAPI contract from the control API"],
  },
  {
    id: "2.no-socks-bind-udp",
    section: 2,
    requirement: "SOCKS5 BIND and UDP are rejected",
    deployed: ["deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic"],
    offline: ["SOCKS5 rejects unsupported commands and route-level protocol exclusions"],
  },
  {
    id: "3.component-separation",
    section: 3,
    requirement:
      "Control, data, routing, adapters, telemetry, internal dashboard, usage accounting, aggregator, and canary have defined boundaries",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: ["Effect generates a complete secured OpenAPI contract from the control API"],
  },
  {
    id: "3.request-flow",
    section: 3,
    requirement: "Credentials load a route, validate target, select candidate, establish upstream, relay, and record attempts",
    deployed: [
      "deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body",
      "deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads",
    ],
    offline: [],
  },
  {
    id: "3.usage-accounting",
    section: 3,
    requirement: "A durable usage-accounting component owns immutable attempt records and cost rollups",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: [
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
      "accounting worker persists hourly, daily, and customer rollups",
    ],
  },
  {
    id: "4.route-fields",
    section: 4,
    requirement: "Protocol, customer, geography, carrier, session, authenticated, retry, and force-provider fields are represented",
    deployed: [
      "deployed route management rejects untrusted and malformed requests",
      "deployed control plane exposes liveness, readiness, OpenAPI, providers, and health",
    ],
    offline: ["route validation supplies behavior defaults and normalizes countries"],
  },
  {
    id: "4.control-contract",
    section: 4,
    requirement: "Effect HttpApi schemas generate and publish a versioned, language-neutral OpenAPI control-plane contract",
    deployed: ["deployed control plane exposes liveness, readiness, OpenAPI, providers, and health"],
    offline: ["versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols"],
  },
  {
    id: "4.contract-compatibility",
    section: 4,
    requirement: "CI validates the generated contract and rejects incompatible control-plane changes before release",
    deployed: [],
    offline: ["OpenAPI compatibility check rejects breaking management-contract changes"],
  },
  {
    id: "4.native-data-plane",
    section: 4,
    requirement: "OpenAPI covers management operations only; HTTP, HTTPS, and SOCKS5 forwarding remain native data-plane protocols",
    deployed: [
      "deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body",
      "deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic",
    ],
    offline: ["versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols"],
  },
  {
    id: "4.trusted-user",
    section: 4,
    requirement: "User identity comes from trusted control-plane claims",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: ["access-grant credentials and mobile affinity survive a service restart"],
  },
  {
    id: "4.auth-city",
    section: 4,
    requirement: "Authenticated routes require and preserve an exact city",
    deployed: [
      "deployed route management rejects untrusted and malformed requests",
      "deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city",
    ],
    offline: ["authenticated CONNECT failover preserves the route's exact city"],
  },
  {
    id: "4.force-provider",
    section: 4,
    requirement: "forceProvider is optional and prevents cross-provider fallback",
    deployed: ["deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies"],
    offline: ["authenticated routes prefer Proxidize and may explicitly use Bright Data"],
  },
  {
    id: "4.immutable-targeting",
    section: 4,
    requirement: "Route targeting changes require a new route",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [],
  },
  {
    id: "4.credential-lifecycle",
    section: 4,
    requirement:
      "Reusable route profiles contain no secrets; independently revocable per-principal grants reveal each secret only on issuance or rotation and use 30-day credentials, seven-day renewal reminders, bounded overlap, immediate compromise rotation, redacted last-use metadata, and idempotent revocation",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [
      "route profiles contain no credential verifier and access grants rotate and revoke independently",
      "mobile device leases are isolated by access grant and survive credential rotation",
      "routine revocation preserves active work and emergency revocation raises the kill switch",
      "routine access-grant revocation preserves an established tunnel while emergency revocation terminates it",
    ],
  },
  {
    id: "5.auth-independent-eligibility",
    section: 5,
    requirement: "Provider capabilities, not intended use alone, determine authenticated and unauthenticated eligibility",
    deployed: [
      "deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies",
      "deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city",
    ],
    offline: ["authenticated routes prefer Proxidize and may explicitly use Bright Data"],
  },
  {
    id: "5.availability-and-capacity",
    section: 5,
    requirement: "A provider and candidate are eligible only when operational, available, and compatible with every route constraint",
    deployed: ["deployed control plane exposes liveness, readiness, OpenAPI, providers, and health"],
    offline: [
      "an unhealthy assigned mobile device fails over within the route's exact city",
      "route validation rejects incompatible mobile and ZIP policies",
    ],
  },
  {
    id: "5.provider-class-ordering",
    section: 5,
    requirement:
      "Authenticated routes order all device-backed providers before residential providers and unauthenticated routes use the reverse order",
    deployed: [
      "deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies",
      "deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city",
    ],
    offline: [
      "authenticated routes prefer Proxidize and may explicitly use Bright Data",
      "capability health follows preferred provider classes without penalizing a healthy preferred class",
    ],
  },
  {
    id: "5.candidate-hierarchy",
    section: 5,
    requirement: "Try same-provider candidates before up to three providers with bounded candidate counts",
    deployed: [],
    offline: ["CONNECT exhausts two peers in the selected provider before cross-provider failover"],
  },
  {
    id: "5.exact-city-levels",
    section: 5,
    requirement: "Exact-city support is guaranteed, verifiable, or unsupported with a two-candidate verification budget",
    deployed: ["deployed control plane exposes liveness, readiness, OpenAPI, providers, and health"],
    offline: ["route validation rejects incompatible mobile and ZIP policies"],
  },
  {
    id: "5.rotation-control",
    section: 5,
    requirement: "Provider-managed rotation is disabled and service rotation is explicit or scheduled",
    deployed: [
      "deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies",
      "deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city",
    ],
    offline: ["scheduled mobile rotation retains the assigned device and region"],
  },
  {
    id: "5.commit-boundary",
    section: 5,
    requirement: "Failover occurs only before request/tunnel commitment and plain HTTP is not replayed",
    deployed: ["deployed target statuses and redirects remain caller-owned and are never replayed"],
    offline: ["plain HTTP provider statuses are returned without failover"],
  },
  {
    id: "5.target-status",
    section: 5,
    requirement: "Target HTTP statuses do not trigger failover",
    deployed: ["deployed target statuses and redirects remain caller-owned and are never replayed"],
    offline: [],
  },
  {
    id: "5.time-budgets",
    section: 5,
    requirement: "Attempts are capped at ten seconds and establishment at thirty seconds",
    deployed: [],
    offline: ["candidate establishment enforces per-attempt and overall deadlines without backoff"],
  },
  {
    id: "5.device-leases",
    section: 5,
    requirement:
      "Device candidates are exclusively leased within an access grant, optionally keyed by sessionId, with activity renewal, explicit release, a durable 15-minute sliding idle timeout, and no absolute cap",
    deployed: [],
    offline: [
      "device leases are exclusive, session-shareable, sliding, releasable, and durable",
      "DynamoDB device leases conditionally lock endpoints and survive gateway-local state",
      "mobile device leases are isolated by access grant and survive credential rotation",
    ],
  },
  {
    id: "6.bright-data",
    section: 6,
    requirement: "Bright Data implements targeting, sessions, rotation, usage dimensions, and opaque assignment evidence",
    deployed: ["deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies"],
    offline: ["Bright Data credentials encode targeting and pin each per-request candidate to a unique constant session"],
  },
  {
    id: "6.proxidize",
    section: 6,
    requirement: "Proxidize implements inventory, credentials, location, device capacity, health, and rotation",
    deployed: ["deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city"],
    offline: ["mobile routes preserve affinity, rotate in-region, and distribute new routes"],
  },
  {
    id: "6.provider-metadata",
    section: 6,
    requirement: "Capabilities, health, pricing, usage, and assignment evidence use APIs or versioned configuration",
    deployed: ["deployed control plane exposes liveness, readiness, OpenAPI, providers, and health"],
    offline: ["Bright Data health uses the authenticated residential network-status API when configured"],
  },
  {
    id: "6.runtime",
    section: 6,
    requirement: "Node.js, TypeScript 7, Effect OpenTelemetry, and configurable OTLP are used",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: ["OpenTelemetry mode keeps console output as an error-only fallback"],
  },
  {
    id: "6.deployment",
    section: 6,
    requirement: "Provider-neutral SST deployment modules isolate AWS as the v0 infrastructure provider",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: ["SST isolates AWS resources behind a provider-selected deployment module"],
  },
  {
    id: "6.aws-compute",
    section: 6,
    requirement:
      "AWS v0 uses separate ECS Fargate services, an internal proxy NLB with explicit transport settings, durable shared state, and an API Gateway/Lambda canary with packaged GeoIP",
    deployed: [
      "deployed ECS components are independent Fargate services with dedicated telemetry collectors",
      "deployed networks isolate the canary and keep status and aggregation internal",
      "deployed DynamoDB and Axiom datasets preserve durable state and retention",
    ],
    offline: ["SST isolates AWS resources behind a provider-selected deployment module"],
  },
  {
    id: "7.logical-attempt-telemetry",
    section: 7,
    requirement: "Logical operations and upstream attempts carry attribution, assignment, outcomes, latency, failover, and byte counts",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: ["data-plane attempt logs include attribution and byte counts without request content"],
  },
  {
    id: "7.authoritative-usage-ledger",
    section: 7,
    requirement:
      "Every upstream attempt creates an unsampled idempotent record with operation, attribution, provider, outcome, bytes, lease, and pricing context",
    deployed: [],
    offline: ["usage records are immutable and idempotent"],
  },
  {
    id: "7.cost-semantics",
    section: 7,
    requirement: "Usage-priced and device-priced estimates reconcile to provider spend; unassigned capacity is attributed to Unallocated",
    deployed: [],
    offline: [
      "usage-priced traffic is estimated from billable bytes and historical price",
      "device-priced traffic unions overlapping leases including idle time",
      "provider totals reconcile authoritative spend while grouped attribution stays estimated",
      "unassigned device capacity is attributed to the synthetic Unallocated customer",
    ],
  },
  {
    id: "7.reconciliation-variance",
    section: 7,
    requirement:
      "Reconciliation durably records variance, posts unexplained differences to Unallocated, and classifies warning/error evidence",
    deployed: [],
    offline: [
      "reconciliation persists variance evidence and posts unexplained differences to Unallocated",
      "variance thresholds enforce the absolute floor, 5% warning, 15% error, and repeated-warning escalation",
    ],
  },
  {
    id: "7.billing-boundary",
    section: 7,
    requirement: "Accounting outputs are internal billing inputs and do not execute charges or customer approval",
    deployed: [],
    offline: ["accounting worker persists hourly, daily, and customer rollups"],
  },
  {
    id: "7.capacity-utilization",
    section: 7,
    requirement:
      "Preallocated capacity reports current and time-weighted utilization while separating healthy idle and paid unhealthy time",
    deployed: [],
    offline: ["preallocated capacity reports time-weighted and current utilization with unhealthy capacity separated"],
  },
  {
    id: "7.destination-resolution",
    section: 7,
    requirement:
      "Traces and logs capture provider and local destination resolution, divergence, verification availability, and unsafe-result warnings",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: ["provider-side DNS remains authoritative while local and provider observations are diagnostic"],
  },
  {
    id: "7.axiom-backend",
    section: 7,
    requirement: "Collectors batch, retry, filter, and securely export logs, traces, and metrics to dedicated Axiom datasets",
    deployed: [
      "deployed ECS components are independent Fargate services with dedicated telemetry collectors",
      "deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads",
    ],
    offline: ["SST isolates AWS resources behind a provider-selected deployment module"],
  },
  {
    id: "7.trace-sampling",
    section: 7,
    requirement: "Version zero exports every trace without sampling while metrics and usage signals remain unsampled",
    deployed: [
      "deployed ECS components are independent Fargate services with dedicated telemetry collectors",
      "deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads",
    ],
    offline: ["v0 trace sampling records every trace"],
  },
  {
    id: "7.metric-cardinality",
    section: 7,
    requirement: "Metrics exclude peer, device, session, IP, route, and user cardinality",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: [],
  },
  {
    id: "7.telemetry-redaction",
    section: 7,
    requirement: "Telemetry omits bodies, raw headers, query strings, credentials, cookies, and tokens",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: ["structured logs redact credentials, cookies, authorization, and URL queries"],
  },
  {
    id: "7.canary-security-schema",
    section: 7,
    requirement: "Canary security events use a separate OTLP stream and safe schema",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: ["public canary keeps access events on its security logger"],
  },
  {
    id: "7.log-retention",
    section: 7,
    requirement: "Detailed proxy and canary logs retain thirty days by default with explicit retention policy",
    deployed: ["deployed DynamoDB and Axiom datasets preserve durable state and retention"],
    offline: [],
  },
  {
    id: "7.public-only",
    section: 7,
    requirement:
      "Explicit private, special-purpose, metadata, and disallowed-port targets are rejected without making local DNS authoritative",
    deployed: ["deployed gateways enforce route protocols, public destinations, ports, and credential-free targets"],
    offline: ["literal target validation blocks explicit private, metadata, and reserved addresses without using local DNS for routing"],
  },
  {
    id: "7.provider-dns",
    section: 7,
    requirement:
      "Every upstream connection preserves domain targets for provider-side resolution while local DNS is non-blocking observation only",
    deployed: [
      "deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body",
      "deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic",
    ],
    offline: ["provider-side DNS remains authoritative while local and provider observations are diagnostic"],
  },
  {
    id: "7.no-direct-fallback",
    section: 7,
    requirement: "Target traffic never falls back to the service's direct connection",
    deployed: [],
    offline: [
      "plain HTTP provider statuses are returned without failover",
      "provider authentication, rate limiting, and unavailable peers are normalized",
    ],
  },
  {
    id: "7.redirect-validation",
    section: 7,
    requirement: "Redirects remain caller-owned and every follow-up request is independently validated",
    deployed: [
      "deployed target statuses and redirects remain caller-owned and are never replayed",
      "deployed gateways enforce route protocols, public destinations, ports, and credential-free targets",
    ],
    offline: [],
  },
  {
    id: "8.capability-status",
    section: 8,
    requirement: "Status exposes four capability names and operational, degraded, or unavailable states",
    deployed: ["deployed health aggregator and status application expose durable capability state and freshness"],
    offline: ["capability aggregation keeps freshness separate and requires corroboration for unavailability"],
  },
  {
    id: "8.internal-dashboard",
    section: 8,
    requirement:
      "The internal dashboard supports overall and per-customer usage, configurable ranges, intervals, grouping, filters, and cost status",
    deployed: [],
    offline: ["internal dashboard usage API supports time presets, grouping, and filters"],
  },
  {
    id: "8.freshness",
    section: 8,
    requirement: "Provider and end-to-end timestamps and stale data are separate from availability",
    deployed: ["deployed health aggregator and status application expose durable capability state and freshness"],
    offline: ["status application serves durable snapshots, history, and explicit staleness"],
  },
  {
    id: "8.passive-provider-signals",
    section: 8,
    requirement:
      "Provider status and passive OTel outcomes feed durable aggregation while Axiom receives evidence but does not decide health",
    deployed: [
      "deployed passive traffic reaches the health aggregator through the product telemetry collector",
      "deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads",
    ],
    offline: ["health aggregator accepts collector-filtered OTLP JSON passive outcomes"],
  },
  {
    id: "8.synthetic-policy",
    section: 8,
    requirement: "Synthetic checks are conflict/on-demand, coalesced, cooled down, controlled, and not sole outage evidence",
    deployed: ["deployed signed public canary works directly and through the normal proxy path without replay"],
    offline: [
      "synthetic validation coalesces concurrent requests and shares its cooldown",
      "capability aggregation keeps freshness separate and requires corroboration for unavailability",
    ],
  },
  {
    id: "8.canary-control",
    section: 8,
    requirement: "Signed canary returns observed egress and direct control distinguishes proxy-path failures",
    deployed: ["deployed signed public canary works directly and through the normal proxy path without replay"],
    offline: ["signed synthetic probe uses the normal proxy path and a direct control on proxy failure"],
  },
  {
    id: "8.canary-geoip",
    section: 8,
    requirement:
      "Canary derives approximate geography only for its observed connection source from a local MaxMind GeoLite2 City MMDB and returns version evidence",
    deployed: ["deployed signed public canary works directly and through the normal proxy path without replay"],
    offline: [
      "public canary trusts forwarding headers only from configured load-balancer CIDRs",
      "local GeoIP resolver activates versioned MaxMind evidence and marks weak data unverifiable",
      "synthetic GeoIP mismatch degrades expected geography without rewriting it as observed",
    ],
  },
  {
    id: "8.geoip-refresh",
    section: 8,
    requirement: "GeoLite2 City updates are checked twice weekly, validated, and packaged atomically with the canary deployable",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: ["MaxMind updater checks with HEAD, downloads MMDB, and skips the current build"],
  },
  {
    id: "8.deployment-isolation",
    section: 8,
    requirement:
      "Proxy, control, status, aggregator, notification, telemetry, and canary have separate ingress, identities, scaling, and canary network isolation",
    deployed: [
      "deployed ECS components are independent Fargate services with dedicated telemetry collectors",
      "deployed networks isolate the canary and keep status and aggregation internal",
    ],
    offline: [],
  },
  {
    id: "8.durable-status",
    section: 8,
    requirement: "Status survives proxy failure by reading durable snapshots and history",
    deployed: [
      "deployed health aggregator and status application expose durable capability state and freshness",
      "deployed DynamoDB and Axiom datasets preserve durable state and retention",
    ],
    offline: [],
  },
  {
    id: "8.alert-finalization",
    section: 8,
    requirement: "Finalized capability states create durable alert/recovery episodes with degraded delay",
    deployed: [],
    offline: ["alert episodes persist, delay degraded alerts, alert unavailable immediately, and recover"],
  },
  {
    id: "8.webhook-delivery",
    section: 8,
    requirement: "Signed webhooks retry, deduplicate, track delivery, and cannot break health evaluation",
    deployed: [],
    offline: [
      "webhook delivery is signed, retried, deduplicated, and tracked",
      "notification failures cannot prevent finalized health persistence",
    ],
  },
  {
    id: "8.alert-owner",
    section: 8,
    requirement: "The health aggregator owns capability alerts and recovery in v0; Axiom may own only non-capability engineering alerts",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: [
      "alert destination configuration is versioned and requires secure operator endpoints",
      "capability health and recovery alert ownership remains with the service in v0",
    ],
  },
  {
    id: "9.repository-policy",
    section: 9,
    requirement: "GitHub review, ownership, merge, branch cleanup, notification, and merge-queue policy is explicit",
    deployed: [],
    offline: ["repository delivery policy encodes required CI, review, dependency, migration, and live-probe gates"],
  },
  {
    id: "9.ci-toolchain",
    section: 9,
    requirement: "Formatting, type-aware lint, TypeScript 7, Vitest, Effect, fast-check, OpenAPI, test, and build gates run in CI",
    deployed: [],
    offline: ["repository delivery policy encodes required CI, review, dependency, migration, and live-probe gates"],
  },
  {
    id: "9.provider-contracts",
    section: 9,
    requirement: "Provider contracts are normalized, pinned, simulator-tested, and checked for upstream freshness",
    deployed: [],
    offline: [
      "provider contracts are pinned and checked for freshness",
      "provider authentication, rate limiting, and unavailable peers are normalized",
    ],
  },
  {
    id: "9.ephemeral-aws",
    section: 9,
    requirement: "Pull requests use production-shaped isolated AWS environments with cleanup and a TTL janitor",
    deployed: [],
    offline: ["AWS delivery workflows build once, promote unchanged, serialize releases, and clean ephemeral stages"],
  },
  {
    id: "9.developer-stages",
    section: 9,
    requirement: "Personal SST developer stages isolate resources and centralize necessary typed configuration differences",
    deployed: [],
    offline: [
      "developer stages are isolated and destination simulators preserve configurable recipient behavior",
      "stage configuration isolates personal stages with safe provider and capacity defaults",
    ],
  },
  {
    id: "9.destination-simulators",
    section: 9,
    requirement: "Destination simulators vary response status, headers, payload, latency, and connection behavior",
    deployed: [],
    offline: [
      "developer stages are isolated and destination simulators preserve configurable recipient behavior",
      "the ephemeral CI transport origin echoes native requests, statuses, redirects, and replay counts",
    ],
  },
  {
    id: "9.migrations",
    section: 9,
    requirement: "Every PR declares migration impact and ordered restartable migrations are exercised through upgrade and rollback",
    deployed: [],
    offline: [
      "migration policy requires one declaration and CODEOWNER confirmation for sensitive migration-none changes",
      "migration runner applies every unapplied migration in order and is restartable",
    ],
  },
  {
    id: "9.promotion",
    section: 9,
    requirement: "One immutable candidate is promoted from staging to production with serialized cumulative reconciliation",
    deployed: [],
    offline: [
      "AWS delivery workflows build once, promote unchanged, serialize releases, and clean ephemeral stages",
      "release candidate coalescing deploys only the current cumulative main commit",
    ],
  },
  {
    id: "9.tunnel-drain",
    section: 9,
    requirement: "Gateway releases track retiring tunnels durably and notify, escalate, terminate, or extend on the documented timeline",
    deployed: [],
    offline: [
      "gateway releases persist active tunnels and enforce the staged drain escalation policy",
      "deployment coordinator ignores green tunnels and drains blue with durable policy state",
      "deployment drain policy polls, notifies, escalates, terminates, and honors time-bounded extensions",
    ],
  },
  {
    id: "10.adapter-extensibility",
    section: 10,
    requirement: "New adapters declare normalized protocol, geography, session, DNS, usage, pricing, and health capabilities",
    deployed: ["deployed control plane exposes liveness, readiness, OpenAPI, providers, and health"],
    offline: ["Effect generates a complete secured OpenAPI contract from the control API"],
  },
  {
    id: "10.proxidize-next-ip",
    section: 10,
    requirement: "Next-connection reliability of Proxidize's IP field remains open",
    deployed: [],
    offline: [],
    deferred: true,
  },
] as const;
