export const DESIGN_DOCUMENT_ID = "1Ud9m_c7YEYxjXS2QOiuCAKYMT5WVGzuN5oshEbm5zfU";
export const DESIGN_DOCUMENT_REVISION =
  "ALtnJHxufQkYM3pOsBB4xcbFLpsxBElB4_zkt9aXWHvHhOOTXMxcxWtpKeRd5MZs5MygnOXnn_QEGV7fw1QgYQf85mk13op1oDZ1sVu4Fw4";

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
    requirement: "Requests, performance, usage, and cost remain attributable to user, customer, optional job, and provider path",
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
      "V0 supplies request monitoring, provider-neutral compatibility and failover, passive health, hard geography, shared mobile capacity observation, and basic usage analytics while roadmap work is not a release gate",
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
    id: "3.1.explicit-boundaries",
    section: 3,
    requirement:
      "Control plane, gateways, routing, adapters, and operational-plane responsibilities communicate through versioned proxy, OpenAPI, adapter, read-model, and OTLP contracts rather than private implementation details",
    deployed: ["deployed ECS components are independent Fargate services with dedicated telemetry collectors"],
    offline: [
      "versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols",
      "SST isolates AWS resources behind a provider-selected deployment module",
    ],
  },
  {
    id: "3.2.control-contract",
    section: 3,
    requirement:
      "Effect schemas generate the authoritative OpenAPI for profile, grant, managed-session, stateless-credential, and credential lifecycle operations",
    deployed: ["deployed control plane exposes provider-neutral liveness, readiness, and OpenAPI"],
    offline: [
      "Effect generates a complete secured OpenAPI contract from the control API",
      "OpenAPI compatibility check rejects breaking management-contract changes",
    ],
  },
  {
    id: "3.2.profile-requirements",
    section: 3,
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
    id: "3.2.grant-session-model",
    section: 3,
    requirement:
      "Grant creation requires managed or none, supports immutable job attribution, creates best-effort managed affinity or an explicitly stateless credential, and never owns caller application-session state",
    deployed: ["deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles"],
    offline: [
      "logical-session APIs require an explicit mode and support rotation, close, and force-close lifecycle",
      "managed-session concurrency converges on one binding and ignores soft saturation after placement",
    ],
  },
  {
    id: "3.2.credential-lifecycle",
    section: 3,
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
    id: "3.3.native-request-flow",
    section: 3,
    requirement:
      "Each new connection resolves service-owned state, validates the destination, establishes a compatible upstream, preserves native proxy semantics, and records the logical operation and every attempt",
    deployed: ["deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body"],
    offline: [
      "plain HTTP preserves method, path, headers, and streamed body",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
    ],
  },
  {
    id: "3.3.streaming",
    section: 3,
    requirement: "HTTP bodies and bidirectional tunnels use bounded backpressure without application-level body caps",
    deployed: ["deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic"],
    offline: [
      "plain HTTP forwards request chunks before the caller completes the body",
      "plain HTTP streams bodies larger than the bounded transport buffer without application caps",
      "CONNECT and SOCKS5 tunnels stream through the same bounded transport buffer",
    ],
  },
  {
    id: "3.3.commitment",
    section: 3,
    requirement:
      "Retries and failover stop at the protocol commitment boundary, never replay application bytes, and never treat target HTTP status as a routing failure",
    deployed: ["deployed target statuses and redirects remain caller-owned and are never replayed"],
    offline: [
      "plain HTTP retries connection establishment before consuming a streamed request body",
      "plain HTTP provider statuses after commitment are returned without replay or failover",
    ],
  },
  {
    id: "3.4.eligibility-and-preference",
    section: 3,
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
    id: "3.4.v0-load-order",
    section: 3,
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
    id: "3.4.bounded-failover",
    section: 3,
    requirement:
      "Pre-commit failover exhausts same-provider candidates before compatible providers and classes while preserving hard geography and the provisional two-candidate, three-provider, ten-second, thirty-second budget",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "managed CONNECT failover preserves the route's exact city",
      "candidate establishment enforces per-attempt and overall deadlines without backoff",
      "stateless CONNECT exhausts residential peers without an incompatible device fallback",
    ],
  },
  {
    id: "3.4.assignment-control",
    section: 3,
    requirement:
      "Adapters suppress provider-managed reassignment when possible, record unavoidable identity changes, share device-backed slots company-wide, and reserve no idle-session capacity",
    deployed: ["deployed Proxidize connections share slot capacity and preserve the exact city"],
    offline: [
      "managed sessions rebind opaque provider affinity after an incompatible profile update",
      "active proxy-slot loads are shared across callers, durable, and released with each connection",
    ],
  },
  {
    id: "3.5.otel-and-attempt-context",
    section: 3,
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
    id: "3.5.usage-ledger",
    section: 3,
    requirement:
      "Every attempt creates an unsampled idempotent immutable usage record with operation, job, attribution, provider path, outcome, bytes, pricing, destination, and applicable capacity context",
    deployed: [],
    offline: [
      "usage records are immutable and idempotent",
      "HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records",
      "usage destination dimensions omit queries and template identifiers conservatively",
    ],
  },
  {
    id: "3.5.cost-attribution",
    section: 3,
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
    id: "3.5.analytics",
    section: 3,
    requirement:
      "The authorized company dashboard provides overall and per-customer trends and the documented job, provider, user, profile, session-mode, destination, geography, and outcome dimensions without exposing provider details in proxy use",
    deployed: [],
    offline: ["company-facing dashboard supports usage filters and provider-neutral credential and session lifecycle views"],
  },
  {
    id: "3.6.capability-health",
    section: 3,
    requirement:
      "Provider and passive evidence produce All Traffic, Managed Sessions, and Stateless Traffic rollups with operational, degraded, unavailable, and freshness semantics that feed routing",
    deployed: ["deployed health aggregator and status application expose durable capability state and freshness"],
    offline: [
      "capability health follows preferred provider classes without penalizing a healthy preferred class",
      "status application serves durable snapshots, history, and explicit staleness",
    ],
  },
  {
    id: "3.6.webhooks",
    section: 3,
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
    id: "3.7.destination-safety",
    section: 3,
    requirement:
      "Every new connection rejects unsafe literals, local names, malformed destinations, disallowed ports, and observable unsafe provider addresses, never uses direct fallback, and treats provider DNS as authoritative",
    deployed: ["deployed gateways enforce public destinations, ports, and credential-free targets"],
    offline: [
      "literal target validation blocks explicit private, metadata, and reserved addresses without using local DNS for routing",
      "provider-side DNS remains authoritative while local and provider observations are diagnostic",
      "destination safety is verified with provider evidence and provider-trusted when DNS is opaque",
    ],
  },
  {
    id: "3.7.data-minimization",
    section: 3,
    requirement:
      "Telemetry and usage omit bodies, raw headers, full URLs, queries, fragments, credentials, cookies, and tokens while retaining only normalized destination and allowlisted assignment metadata",
    deployed: ["deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads"],
    offline: [
      "structured logs redact credentials, cookies, authorization, and URL queries",
      "usage destination dimensions omit queries and template identifiers conservatively",
    ],
  },
  {
    id: "3.8.aws-baseline",
    section: 3,
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
    id: "3.8.delivery-gates",
    section: 3,
    requirement:
      "GitHub Actions validates contracts, routing, safety, streaming, failover, non-replay, session concurrency, and the deployable while environment-gated live probes supplement simulators",
    deployed: [],
    offline: ["repository delivery policy encodes required CI, review, dependency, migration, and live-probe gates"],
  },
  {
    id: "4.1.geographic-roadmap",
    section: 4,
    requirement: "Verified exact-city optimization and the isolated signed public canary are production-roadmap work, not v0 release gates",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "4.2.advanced-routing-roadmap",
    section: 4,
    requirement:
      "Weighted probabilistic scoring, shared capacity circuits, controlled failback, and generalized N-provider orchestration are production-roadmap work, not v0 selection behavior",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "4.3.resource-roadmap",
    section: 4,
    requirement:
      "Multi-dimensional capacity forecasting, recommendations, and optional provider provisioning are production-roadmap work, with Proxidize subscription changes remaining operator-controlled initially",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "4.4.health-roadmap",
    section: 4,
    requirement:
      "Dedicated health aggregation, demand-driven synthetic validation, history and geography drill-down, richer subscriptions, and centralized rule ownership are production-roadmap work",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "4.5.accounting-roadmap",
    section: 4,
    requirement:
      "Provider reconciliation, variance escalation, richer analytics, and replaceable company-platform read models are production-roadmap work rather than charge execution",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "4.6.release-roadmap",
    section: 4,
    requirement:
      "Independent scaling, public-canary Lambda deployment, immutable-artifact promotion, state migration, and blue-green tunnel draining are production-roadmap work",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.1.provider-extensibility",
    section: 5,
    requirement:
      "The v0 adapter contract declares normalized protocol, geography, continuity, assignment, capacity, DNS, safety, pricing, usage, health, and optional provisioning capabilities for future providers",
    deployed: [],
    offline: [
      "every adapter satisfies the normalized provider capability contract and its pinned specification",
      "provider contracts are pinned and checked for freshness",
    ],
  },
  {
    id: "5.2.foundational-unknowns",
    section: 5,
    requirement:
      "Workload, SLO, freshness, accounting-guarantee, and deployment-footprint values remain explicitly unknown until evidence and stakeholder expectations justify architecture commitments",
    deployed: [],
    offline: [],
    deferred: true,
  },
  {
    id: "5.3.v0-policy-hypotheses",
    section: 5,
    requirement:
      "Typed versioned policies centralize provisional 30-day credential lifecycle, two-candidate and three-provider establishment budget, full initial trace export, 30-day log retention, and five-minute degraded alert delay",
    deployed: [],
    offline: [
      "credential metadata enforces expiration and overlap revocation deadlines without exposing verifiers",
      "candidate establishment enforces per-attempt and overall deadlines without backoff",
      "v0 trace sampling records every trace",
      "provisional operational values are typed, versioned policies",
    ],
  },
  {
    id: "5.3.roadmap-policy-hypotheses",
    section: 5,
    requirement:
      "Scoring, verification, reconciliation, and mobile-capacity numeric hypotheses remain typed roadmap inputs rather than v0 release behavior",
    deployed: [],
    offline: [],
    deferred: true,
  },
];
