export const DESIGN_DOCUMENT_ID = "1Ud9m_c7YEYxjXS2QOiuCAKYMT5WVGzuN5oshEbm5zfU";
export const DESIGN_DOCUMENT_REVISION =
  "ALtnJHwXt0oKzvEWY5OpJujNOHv3H45Hq4IsB3vNEAjPk-f-0UpFzo97QFjGpKHME5yBCylducT-m2-1lyZg6lknJUqnYOwJqzwHB6tKAas";

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
    id: "1.provider-neutral-company-service",
    section: 1,
    requirement:
      "Authorized company callers use service credentials and provider-neutral HTTP, HTTPS, and SOCKS5 interfaces while adapters hide Bright Data, Proxidize, and future-provider details",
    deployed: [
      "deployed control plane exposes provider-neutral liveness, readiness, and OpenAPI",
      "deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles",
    ],
    offline: ["every adapter satisfies the normalized provider capability contract and its pinned specification"],
  },
  {
    id: "2.protocol-scope",
    section: 2,
    requirement:
      "The service preserves HTTP forward proxy, HTTP CONNECT, and authenticated SOCKS5 CONNECT while excluding TLS interception, fetch envelopes, SOCKS5 BIND and UDP, and provider-only caller features",
    deployed: [
      "deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body",
      "deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic",
    ],
    offline: ["SOCKS5 rejects unsupported commands", "Effect generates a complete secured OpenAPI contract from the control API"],
  },
  {
    id: "2.attribution",
    section: 2,
    requirement: "Operations, performance, usage, and cost remain attributable to user, customer, optional job, and provider path",
    deployed: ["deployed passive traffic reaches the health aggregator through the product telemetry collector"],
    offline: [
      "data-plane attempt logs include attribution and byte counts without request content",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
    ],
  },
  {
    id: "2.v0-delivery-areas",
    section: 2,
    requirement:
      "V0 supplies operation monitoring, provider-neutral compatibility and failover, passive health, hard geography, shared mobile capacity observation, and basic usage analytics while roadmap work is not a release gate",
    deployed: [
      "deployed health aggregator and status application expose durable capability state and freshness",
      "deployed Proxidize connections share slot capacity and preserve the exact city",
    ],
    offline: [
      "accounting worker persists hourly, daily, and customer rollups",
      "active proxy-slot loads are shared across callers, durable, and released with each connection",
    ],
  },
  {
    id: "3.1.request-monitoring",
    section: 3,
    requirement:
      "V0 records every logical operation and upstream attempt, attributes usage and estimated cost, exposes meaningful operational signals, and provides basic company-facing usage analytics",
    deployed: ["deployed passive traffic reaches the health aggregator through the product telemetry collector"],
    offline: [
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
      "accounting worker persists hourly, daily, and customer rollups",
      "company-facing dashboard supports usage filters and provider-neutral credential and session lifecycle views",
    ],
  },
  {
    id: "3.2.provider-management",
    section: 3,
    requirement:
      "V0 hides provider-specific behavior behind normalized adapters, selects and distributes work from compatibility, health, load, and capacity evidence, and fails over only before commitment without weakening hard constraints",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "every adapter satisfies the normalized provider capability contract and its pinned specification",
      "managed sessions prefer Proxidize while Bright Data remains eligible when it is the compatible provider",
      "plain HTTP provider statuses after commitment are returned without replay or failover",
    ],
  },
  {
    id: "3.3.health-monitoring",
    section: 3,
    requirement:
      "V0 combines available provider status, passive outcomes, and bounded authorized probes into performance-aware capability health, operator notifications, and automatic routing away from unhealthy paths",
    deployed: ["deployed health aggregator and status application expose durable capability state and freshness"],
    offline: [
      "capability health follows preferred provider classes without penalizing a healthy preferred class",
      "alert episodes persist, delay degraded alerts, alert unavailable immediately, and recover",
      "an inconclusive canary check cannot mark health verification unavailable",
    ],
  },
  {
    id: "3.4.geographic-optimization",
    section: 3,
    requirement:
      "V0 treats supplied country, region, city, and carrier as hard gates, selects only from declared compatible coverage, and fails closed when no location-safe fallback remains",
    deployed: [
      "deployed Bright Data routes support fresh exits and exact-city policies",
      "deployed Proxidize connections share slot capacity and preserve the exact city",
    ],
    offline: [
      "profile validation enforces geography hierarchy and rejects every non-canonical field",
      "managed CONNECT failover preserves the route's exact city",
    ],
  },
  {
    id: "3.5.resource-optimization",
    section: 3,
    requirement:
      "V0 observes mobile inventory, active load, usage, soft and hard capacity, health, coverage, and cost to calculate operator-executed allocation recommendations without automatically mutating provider subscriptions",
    deployed: [],
    offline: [
      "preallocated capacity reports time-weighted and current utilization with unhealthy capacity separated",
      "capacity recommendations use the versioned v0 policy and suppress location-limited changes",
      "capacity pressure publishes provider-attributed health evidence and one idempotent planning recommendation per period",
    ],
  },
  {
    id: "4.1.explicit-boundaries",
    section: 4,
    requirement:
      "Control, gateway, routing, adapter, accounting, health, analytics, and notification responsibilities retain explicit ownership across versioned proxy, OpenAPI, adapter, durable-schema, and OTLP boundaries even when deployment or physical storage is shared",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: [
      "versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols",
      "SST isolates AWS resources behind a provider-selected deployment module",
    ],
  },
  {
    id: "4.2.state-ownership",
    section: 4,
    requirement:
      "Durable profiles own routing intent without a chosen provider, managed-session bindings own last-known candidate affinity, retry execution stays operation-scoped, and accounting owns immutable attempt records",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [
      "profile updates apply to new connections without replacing access-grant credentials or exposing providers",
      "managed-session concurrency converges on one binding and ignores soft saturation after placement",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
    ],
  },
  {
    id: "4.2.control-contract",
    section: 4,
    requirement:
      "Effect schemas generate the authoritative OpenAPI for profile, grant, managed-session, no-session credential, and credential lifecycle operations",
    deployed: ["deployed control plane exposes provider-neutral liveness, readiness, and OpenAPI"],
    offline: [
      "Effect generates a complete secured OpenAPI contract from the control API",
      "OpenAPI compatibility check rejects breaking management-contract changes",
    ],
  },
  {
    id: "4.2.profile-requirements",
    section: 4,
    requirement:
      "Profiles contain customer, hard hierarchical geography, optional carrier, required connection-retry intent, and an exceptional provider override that never bypasses eligibility gates",
    deployed: ["deployed route management rejects untrusted and malformed requests"],
    offline: [
      "profile validation accepts only stable requirements and derives routing behavior",
      "profile validation enforces geography hierarchy and rejects every non-canonical field",
      "provider override is explicit, persisted, compatibility-gated, and never falls back",
    ],
  },
  {
    id: "4.2.grant-session-model",
    section: 4,
    requirement:
      "Grant creation requires managed or none, supports immutable job attribution, creates best-effort managed affinity or an explicitly no-session credential, and never owns caller application-session state",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [
      "logical-session APIs require an explicit mode and support rotation, close, and force-close lifecycle",
      "managed-session concurrency converges on one binding and ignores soft saturation after placement",
    ],
  },
  {
    id: "4.2.credential-lifecycle",
    section: 4,
    requirement:
      "Grant-owned bearer credentials reveal passwords only at issuance or rotation, store non-retrievable verifiers, expose only non-secret metadata, and support draining ordinary revocation plus emergency termination",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [
      "route profiles contain no credential verifier and access grants rotate and revoke independently",
      "credential metadata is inspectable and each credential can be revoked independently",
      "routine revocation preserves active work and emergency revocation raises the kill switch",
    ],
  },
  {
    id: "4.3.native-operation-flow",
    section: 4,
    requirement:
      "Each plain HTTP request and each new CONNECT or SOCKS5 tunnel resolves service-owned state, validates its destination, establishes a compatible upstream, preserves native proxy semantics, and records the logical operation and every attempt",
    deployed: ["deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body"],
    offline: [
      "plain HTTP preserves method, path, headers, and streamed body",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
    ],
  },
  {
    id: "4.3.streaming",
    section: 4,
    requirement: "HTTP bodies and bidirectional tunnels use bounded backpressure without application-level body caps",
    deployed: ["deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic"],
    offline: [
      "plain HTTP forwards request chunks before the caller completes the body",
      "plain HTTP streams bodies larger than the bounded transport buffer without application caps",
      "CONNECT and SOCKS5 tunnels stream through the same bounded transport buffer",
    ],
  },
  {
    id: "4.3.commitment",
    section: 4,
    requirement:
      "Retries and failover stop at the protocol commitment boundary, never replay application bytes, and never treat target HTTP status as a routing failure",
    deployed: ["deployed target statuses and redirects remain caller-owned and are never replayed"],
    offline: [
      "plain HTTP retries connection establishment before consuming a streamed request body",
      "plain HTTP provider statuses after commitment are returned without replay or failover",
    ],
  },
  {
    id: "4.4.eligibility-and-preference",
    section: 4,
    requirement:
      "Operational, protocol, safety, geography, carrier, hard-capacity, circuit, and override gates determine eligibility; managed intent prefers device-backed candidates and stateless intent prefers residential candidates",
    deployed: [
      "deployed Bright Data routes support fresh exits and exact-city policies",
      "deployed Proxidize connections share slot capacity and preserve the exact city",
    ],
    offline: [
      "managed sessions prefer Proxidize while Bright Data remains eligible when it is the compatible provider",
      "an unhealthy mobile slot is excluded while exact-city routing remains mandatory",
    ],
  },
  {
    id: "4.4.v0-load-order",
    section: 4,
    requirement:
      "V0 preserves an eligible managed binding and otherwise selects the least-loaded eligible candidate using a stable tie-breaker; soft capacity affects order and health without rejecting traffic or moving an eligible session",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "concurrent mobile connections claim the least-loaded compatible slots with a stable tie-breaker",
      "managed-session concurrency converges on one binding and ignores soft saturation after placement",
      "stateless residential soft saturation promotes an eligible device-backed fallback",
    ],
  },
  {
    id: "4.4.bounded-failover",
    section: 4,
    requirement:
      "Pre-commit failover exhausts same-provider candidates before compatible providers and classes while preserving hard geography and the two-candidate, three-provider, ten-second, thirty-second v0 budget",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "managed CONNECT failover preserves the route's exact city",
      "candidate establishment enforces per-attempt and overall deadlines",
      "stateless CONNECT exhausts residential peers without an incompatible device fallback",
    ],
  },
  {
    id: "4.4.assignment-control",
    section: 4,
    requirement:
      "Adapters suppress provider-managed reassignment when possible, record unavoidable identity changes, share device-backed slots company-wide, and reserve no idle-session capacity",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "managed sessions rebind opaque provider affinity after an incompatible profile update",
      "active proxy-slot loads are shared across callers, durable, and released with each connection",
    ],
  },
  {
    id: "4.4.provider-contract",
    section: 4,
    requirement:
      "The provider boundary requires candidate discovery and proxy-connection materialization while normalized health, capacity, pricing, usage, assignment evidence, and provisioning capabilities may be provider-backed or configuration-backed",
    deployed: [],
    offline: [
      "every adapter satisfies the normalized provider capability contract and its pinned specification",
      "provider contracts are pinned and checked for freshness",
    ],
  },
  {
    id: "4.5.otel-and-attempt-context",
    section: 4,
    requirement:
      "All components export structured telemetry through configurable OTLP while logs and traces distinguish logical operations, upstream attempts, routing and affinity decisions, commitment, bytes, safety, and assignment evidence",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: [
      "OpenTelemetry mode keeps console output as an error-only fallback",
      "data-plane attempt logs include attribution and byte counts without request content",
      "managed session routing emits provider-neutral affinity, rebind, degradation, and failback telemetry",
    ],
  },
  {
    id: "4.5.usage-ledger",
    section: 4,
    requirement:
      "Every attempt creates one unsampled idempotent immutable usage record with operation, optional job, attribution, provider path, outcome, timing, bytes, pricing, destination, and applicable slot, device, or connection context",
    deployed: [],
    offline: [
      "usage records are immutable and idempotent",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
      "usage destination dimensions omit queries and template identifiers conservatively",
    ],
  },
  {
    id: "4.5.cost-attribution",
    section: 4,
    requirement:
      "Usage-priced costs use billable bytes, device-slot costs use customer connection-seconds, and idle paid capacity is assigned to Unallocated",
    deployed: [],
    offline: [
      "usage-priced traffic is estimated from billable bytes and historical price",
      "device-priced slot cost is allocated by customer connection-seconds",
      "idle proxy-slot capacity is attributed to the synthetic Unallocated customer",
    ],
  },
  {
    id: "4.5.reconciliation",
    section: 4,
    requirement:
      "Provider-reported usage remains a separate period aggregate and reconciliation persists explicit adjustment evidence without rewriting immutable attempt records",
    deployed: [],
    offline: [
      "provider totals reconcile authoritative spend while grouped attribution stays estimated",
      "reconciliation persists variance evidence and posts unexplained differences to Unallocated",
    ],
  },
  {
    id: "4.5.analytics",
    section: 4,
    requirement:
      "The authorized company dashboard provides overall and per-customer trends and the documented job, provider, user, profile, session-mode, destination, geography, and outcome dimensions without exposing provider details in proxy use",
    deployed: [],
    offline: ["company-facing dashboard supports usage filters and provider-neutral credential and session lifecycle views"],
  },
  {
    id: "4.6.capability-health",
    section: 4,
    requirement:
      "Provider, passive, and bounded user-triggered synthetic evidence produce traffic and health-verification rollups with operational, degraded, unavailable, freshness, shared-cooldown, and inconclusive-canary semantics that feed routing",
    deployed: ["deployed health aggregator and status application expose durable capability state and freshness"],
    offline: [
      "capability health follows preferred provider classes without penalizing a healthy preferred class",
      "status application serves durable snapshots, history, and explicit staleness",
      "an inconclusive canary check cannot mark health verification unavailable",
    ],
  },
  {
    id: "4.6.webhooks",
    section: 4,
    requirement:
      "Configured signed webhooks notify unavailable immediately, persistent degraded after the policy window, and recovery, with retried deduplicated delivery separated from health classification",
    deployed: [],
    offline: [
      "alert episodes persist, delay degraded alerts, alert unavailable immediately, and recover",
      "webhook delivery is signed, retried, deduplicated, and tracked",
      "notification failures cannot prevent finalized health persistence",
    ],
  },
  {
    id: "4.7.destination-safety",
    section: 4,
    requirement:
      "Every plain HTTP request and each new CONNECT or SOCKS5 tunnel rejects unsafe literals, local names, malformed destinations, disallowed ports, and observable unsafe provider addresses, never uses direct fallback, and treats provider DNS as authoritative",
    deployed: ["deployed gateways enforce public destinations, ports, and credential-free targets"],
    offline: [
      "literal target validation blocks explicit private, metadata, and reserved addresses without using local DNS for routing",
      "provider-side DNS remains authoritative while local and provider observations are diagnostic",
      "destination safety is verified with provider evidence and provider-trusted when DNS is opaque",
    ],
  },
  {
    id: "4.7.data-minimization",
    section: 4,
    requirement:
      "Telemetry and usage omit bodies, raw headers, full URLs, queries, fragments, credentials, cookies, and tokens while retaining only normalized destination and allowlisted assignment metadata",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: [
      "structured logs redact credentials, cookies, authorization, and URL queries",
      "usage destination dimensions omit queries and template identifiers conservatively",
    ],
  },
  {
    id: "4.8.aws-baseline",
    section: 4,
    requirement:
      "Provider-neutral SST deploys the gateway on ECS/Fargate behind a private NLB with durable shared state and contract-separated supporting responsibilities",
    deployed: [
      "deployed ECS components are independent Fargate services with dedicated telemetry collectors",
      "deployed DynamoDB and Axiom datasets preserve durable state and retention",
    ],
    offline: [
      "SST isolates AWS resources behind a provider-selected deployment module",
      "managed access-grant credentials, logical sessions, affinity, and route requirements survive a service restart",
    ],
  },
  {
    id: "4.8.delivery-gates",
    section: 4,
    requirement:
      "GitHub Actions validates contracts, routing, safety, streaming, failover, non-replay, session concurrency, and the deployable while environment-gated live probes supplement simulators",
    deployed: [],
    offline: ["repository delivery policy encodes required CI, review, dependency, migration, and live-probe gates"],
  },
  {
    id: "4.8.signed-public-canary",
    section: 4,
    requirement:
      "V0 deploys the signed HTTP-only public canary behind API Gateway and Lambda in an isolated VPC and reports its health separately from provider and traffic capabilities",
    deployed: [
      "deployed signed public canary works directly and through the normal proxy path without replay",
      "deployed networks isolate the canary and keep status and aggregation private",
    ],
    offline: ["an inconclusive canary check cannot mark health verification unavailable"],
  },
  {
    id: "5.1.geographic-roadmap",
    section: 5,
    requirement:
      "Automated history-backed exact-city verification across provider candidates and geographies is production-roadmap work built on the unchanged v0 hard gates and signed canary",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.2.advanced-routing-roadmap",
    section: 5,
    requirement:
      "Weighted probabilistic scoring, shared capacity circuits, controlled failback, and generalized N-provider orchestration are production-roadmap work, not v0 selection behavior",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.3.resource-roadmap",
    section: 5,
    requirement:
      "Multi-dimensional capacity forecasting, richer evidence-backed recommendation views, and optional provider provisioning are production-roadmap work, while v0 already calculates basic operator-executed allocation recommendations",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.4.health-roadmap",
    section: 5,
    requirement:
      "Dedicated centralized aggregation, conflict-triggered synthetic automation, history, geography drill-down, richer subscriptions, and escalation are production-roadmap work around v0's authorized user-triggered validation",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.5.accounting-roadmap",
    section: 5,
    requirement:
      "Richer reconciliation cadence and variance policy, provider-cost and forecast views, replaceable analytics consumers, and downstream billing workflows extend v0's immutable ledger and explicit adjustment records",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.6.release-roadmap",
    section: 5,
    requirement:
      "Independent scaling, immutable-artifact promotion, state migration, and blue-green tunnel draining are production-roadmap work",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "2.foundational-unknowns",
    section: 2,
    requirement:
      "Workload, SLO, freshness, accounting-guarantee, geography, data-residency, and multi-region values remain explicitly unknown until evidence and stakeholder expectations justify architecture commitments",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "6.v0-policy",
    section: 6,
    requirement:
      "One typed versioned v0 policy centralizes only the 30-day credential lifecycle and the two-candidate, three-provider, ten-second, thirty-second establishment budget; all other tunable values remain unanswered as design commitments",
    deployed: [],
    offline: [
      "credential metadata enforces expiration and overlap revocation deadlines without exposing verifiers",
      "candidate establishment enforces per-attempt and overall deadlines",
      "authoritative v0 values live in one typed, versioned policy",
    ],
  },
];
