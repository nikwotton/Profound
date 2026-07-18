# Consumer guide

This guide covers Profound Proxy Router v0's provider-neutral control plane and its standard HTTP/HTTPS and SOCKS5 data plane. Deployment, monitoring, and incident procedures are in the [operations guide](OPERATIONS.md).

## Concepts

- A **route profile** stores stable workload requirements. It contains no protocol choice, session or rotation policy, caller secret, or provider secret; the optional `providerOverride` is its sole provider constraint.
- An **access grant** is the authorization, ownership, and credential boundary for one route profile. It contains managed sessions and/or explicitly stateless credentials, but does not reserve capacity.
- A **logical session** is an optional, provider-neutral best-effort affinity scope. It may remember an opaque provider binding across connections; it is not an exclusive slot, device, or IP lease and does not own target cookies or tokens.
- A **credential** authenticates one access grant and is either scoped to one managed session or explicitly stateless. Its opaque username is stable for that credential; its password is shown only when issued or rotated.
- The **data plane** accepts native proxy traffic. Clients keep the original destination URL, method, path, query, headers, body, redirects, and TLS behavior.

The control bearer token and proxy credential are separate:

- `Authorization: Bearer ...` authenticates a trusted control-plane caller.
- `Proxy-Authorization: Basic ...` or SOCKS5 username/password authenticates a data-plane credential.
- A target-site `Authorization` header remains target traffic and is forwarded unchanged.

## Endpoints

Obtain deployed values from the platform operator. Local mock-mode defaults are:

| Interface           | Address                    |
| ------------------- | -------------------------- |
| Control API         | `http://127.0.0.1:8081`    |
| HTTP/HTTPS proxy    | `http://127.0.0.1:8080`    |
| SOCKS5 proxy        | `socks5h://127.0.0.1:1080` |
| Local control token | `change-me`                |

The gateway protocol is selected by the endpoint and proxy handshake. It is deliberately absent from route profiles.

## Create a profile and credential

Create a provider-neutral route profile:

```sh
curl -sS http://127.0.0.1:8081/v1/profiles \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "customer-a",
    "geography": {
      "countryCode": "US",
      "regionCode": "NY",
      "city": "New York"
    },
    "carrier": "T-Mobile",
    "allowConnectionRetry": false
  }'
```

The `201` response contains only the new identifier:

```json
{ "profileId": "PROFILE_ID" }
```

Issue an access grant and explicitly select managed affinity or stateless operation:

```sh
curl -sS -X POST http://127.0.0.1:8081/v1/profiles/PROFILE_ID/grants \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "managed", "jobId": "collection-job-123" }'
```

`sessionMode` is required; omission is invalid. `managed` creates an initial logical session and session-scoped credential, while `none` creates a stateless credential with no cross-connection continuity preference. Optional `jobId` is immutable for that grant, is returned by grant list/read operations, may be reused across grants under the same customer, and is inherited by usage, logs, and telemetry. It does not replace the distinct per-operation `logicalOperationId`. The `201` response contains redacted `grant` metadata, credential-free `endpoints`, the optional managed `session`, and a `credential` with `credentialId`, opaque `username`, and one-time `password`. Store the password immediately in a secret manager. It cannot be retrieved later. Do not construct a username from a profile, grant, or session ID.

## Send proxy traffic

HTTPS through the HTTP proxy:

```sh
curl --proxy 'http://127.0.0.1:8080' \
  --proxy-user 'OPAQUE_USERNAME:ONE_TIME_PASSWORD' \
  https://example.com/
```

The client sends `CONNECT example.com:443` to Profound. The selected provider creates the recipient-side connection, so the recipient sees the provider exit IP. TLS remains end-to-end between client and recipient; v0 does not install a trusted interception certificate or inspect encrypted application traffic.

Plain HTTP through the HTTP proxy:

```sh
curl --proxy 'http://127.0.0.1:8080' \
  --proxy-user 'OPAQUE_USERNAME:ONE_TIME_PASSWORD' \
  http://example.com/
```

The client sends an absolute-form request target. Profound removes proxy-only authentication and preserves target method, path, query, headers, body, statuses, and redirects. Request and response bodies stream with bounded backpressure after a compatible upstream connection is established; v0 does not impose application-level HTTP body-size caps.

SOCKS5 with provider-side DNS:

```sh
curl --socks5-hostname '127.0.0.1:1080' \
  --proxy-user 'OPAQUE_USERNAME:ONE_TIME_PASSWORD' \
  https://example.com/
```

V0 supports authenticated SOCKS5 TCP `CONNECT`; it rejects unauthenticated negotiation, `BIND`, and `UDP ASSOCIATE`.

## Route profile contract

The committed [OpenAPI contract](../openapi/profound-control-api.v0.10.0.json) is authoritative.

| Field                   | Required    | Behavior                                                                                                                                                                               |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerId`            | Yes         | Non-empty attribution value.                                                                                                                                                           |
| `geography.countryCode` | Conditional | Optional two-letter ISO code, normalized to uppercase; required when region or city is supplied.                                                                                       |
| `geography.regionCode`  | No          | State or region hard constraint; requires country.                                                                                                                                     |
| `geography.city`        | No          | Exact-city hard constraint; requires country.                                                                                                                                          |
| `carrier`               | No          | Carrier hard constraint.                                                                                                                                                               |
| `providerOverride`      | No on write | `bright_data` or `proxidize`; constrains routing without bypassing compatibility, safety, health, or capacity. Profile reads always return this field and use `null` when it is unset. |
| `allowConnectionRetry`  | Yes         | Permits safe pre-commit connection-establishment retries.                                                                                                                              |

Unknown fields are rejected. In particular, profiles do not accept target-authentication state, `name`, `protocol`, `allowedProtocols`, `targeting`, `rotation`, `session`, `retryPolicy`, `provider`, `principalId`, or `userId`.

Every supplied geography level is a hard gate for initial placement, retry, failover, rebind, and failback; city means exact city. Target-site authentication remains ordinary pass-through traffic and is deliberately not part of the routing contract. Profile responses omit other unset optional fields but always return `providerOverride` as a provider ID or `null`; chosen-provider details, pricing, and health remain service-private and appear only in authorized dashboard and telemetry views.

Replace the stable requirements with `PUT /v1/profiles/{id}`. New connections use the replacement; established requests and tunnels continue under the policy with which they opened.

## Access grants, sessions, and credentials

An access grant owns independently revocable authorization for one profile. Managed sessions and stateless credentials live under it. A managed session records non-exclusive, last-known affinity while it is open; an idle session reserves no capacity and sends no keepalive traffic. Stateless credentials are placed independently for every connection. Multiple grants, callers, sessions, and connections may share provider capacity.

| Operation                      | Endpoint                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| Create/list profiles           | `POST /v1/profiles`, `GET /v1/profiles`                                 |
| Inspect/replace/remove profile | `GET`, `PUT`, `DELETE /v1/profiles/{id}`                                |
| Create/list grants             | `POST`, `GET /v1/profiles/{id}/grants`                                  |
| Inspect/revoke grant           | `GET`, `DELETE /v1/grants/{grantId}`                                    |
| Create stateless credential    | `POST /v1/grants/{grantId}/credentials`                                 |
| Rotate credential              | `POST /v1/grants/{grantId}/credentials/{credentialId}/rotate`           |
| Replace compromised credential | `POST /v1/grants/{grantId}/credentials/{credentialId}/emergency-rotate` |
| Inspect/revoke credential      | `GET`, `DELETE /v1/grants/{grantId}/credentials/{credentialId}`         |
| Create/list managed sessions   | `POST`, `GET /v1/grants/{grantId}/sessions`                             |
| Inspect/close session          | `GET`, `DELETE /v1/grants/{grantId}/sessions/{sessionId}`               |
| Force-close session            | `POST /v1/grants/{grantId}/sessions/{sessionId}/force-close`            |

Closing a session rejects new connections immediately and lets established work drain. Force-close also terminates active connections. Sessions otherwise stay open until explicitly closed or their grant/profile is revoked. Revoking a grant closes all its sessions for new connections while established work drains.

Credentials have a fixed 30-day lifetime. `renewalDueAt` is seven days before expiry. Routine rotation leaves the selected prior credential in bounded overlap for at most 72 hours or until original expiry. Emergency rotation invalidates the selected suspected credential immediately. Rotation preserves `sessionMode` and `sessionId`; it never creates a new logical identity.

Issuance responses contain a compact grant summary plus the new credential and credential-free endpoints. Profile, grant, session, and credential list/read responses never include passwords, verifiers, provider credentials, provider affinity, device identifiers, IP assignments, or proxy URLs with embedded credentials.

## Routing and retry behavior

Provider selection and provider-specific rotation are private service implementation policy. Consumers declare stable requirements, not mechanisms.

`providerOverride` is the one deliberate exception: set it to `bright_data` or `proxidize` only when a workload must constrain the vendor, or omit it for ordinary provider-neutral routing. An override never bypasses protocol, geography, safety, health, hard-capacity, or circuit checks. If the named provider cannot satisfy the profile, the control plane returns `provider_override_unsatisfied`; the data plane does not fall back to another provider.

Within the applicable provider-preference tier, v0 selects the least-loaded eligible candidate using a stable identifier as the tie-breaker. A candidate at its soft capacity limit remains an overflow option rather than being rejected. Managed sessions prefer device-backed providers and remain within that class through soft saturation. Stateless traffic prefers residential providers, but residential soft saturation promotes a compatible unsaturated device-backed candidate ahead of saturated residential overflow. The weighted reliability, headroom, performance, cost, and stability score is emitted only as a shadow roadmap diagnostic; it does not control v0 selection.

- `sessionMode` controls provider-class preference; target authentication never does. Managed sessions prefer device-backed providers and stateless traffic prefers residential providers.
- `sessionMode: "none"` has no cross-connection affinity. Managed sessions first try their eligible recorded binding and preserve it through soft saturation; new sessions and no-session connections use normal least-loaded placement.
- A managed binding may rebind atomically after ineligibility, effective hard capacity, an open circuit, a pre-commit failure, or an incompatible profile update. Concurrent connections converge on the winning binding instead of deliberately splitting identities.
- A managed cross-class fallback remains marked degraded. A later real connection may probe the preferred class after policy-controlled health-stability and quiescence windows; success rebinds atomically and failure restarts stabilization.
- Bright Data remains eligible for managed sessions when it satisfies all constraints; Proxidize remains eligible for stateless traffic and subject to inventory and capacity.
- Repeated proxy-controlled pre-commit establishment/capacity failures and provider-reported hard limits may open a shared capacity circuit. Cooldown, backoff, and half-open probing are implementation policy rather than v0 API guarantees.
- The authoritative v0 establishment budget considers at most two candidates per provider and three providers per logical operation. Each attempt has 10 seconds and the operation has 30 seconds overall.
- `allowConnectionRetry` only permits another upstream establishment attempt before commitment. Plain HTTP commits when its first application-request byte is written upstream; CONNECT and SOCKS5 commit when tunnel establishment is acknowledged to the caller or a tunneled byte is relayed.
- Target HTTP responses, provider-authentication failures, and failures after commit are not hidden by failover.
- No operation ever falls back to the router's direct Internet connection.

## Errors

Control-plane errors are provider-neutral and contain:

```json
{
  "code": "normalized_code",
  "message": "sanitized explanation",
  "retryable": false,
  "requestId": "correlation-id"
}
```

Every control-plane error uses exactly this envelope. `401` means the control credential is missing or invalid; `404` intentionally covers absent, revoked, or non-owned resources; `503` means the required service capability is unavailable. Data-plane authentication failures return HTTP `407` or SOCKS5 authentication failure.

## Destination and transport safety

- Explicit loopback, private, link-local, multicast, reserved, metadata, and special-use IP literals are rejected.
- `localhost` and operator-configured local-only hostnames or parent domains are rejected.
- Domains remain intact for provider-side DNS. Local DNS is diagnostic only and cannot reroute the operation.
- Provider-selected addresses are classified `verified` when the adapter can observe or constrain them; verified private or special-purpose results are rejected.
- Opaque DNS is classified `provider-trusted` and is eligible only for third-party exits with no protected company-network reachability. Bright Data and Proxidize meet that external-provider boundary, but the gateway does not claim complete SSRF enforcement for resources reachable from a provider's own network.
- Target URL credentials and credentials in `CONNECT` authorities are rejected.
- Target ports default to `80` and `443`; operators may deliberately allow more public TCP ports.
- Plain HTTP, HTTP CONNECT, and SOCKS5 all stream through a small bounded transport buffer with backpressure; v0 has no application-body caps.

## Privacy and logging

Operational telemetry may include timestamps, operation and correlation IDs, profile/grant/customer identifiers, protocol, target hostname and port, target method and status for plain HTTP, provider class and provider identifier in restricted telemetry only, normalized outcome, duration, byte counts, retry count, and sanitized assignment evidence. Restricted logs and traces may carry a proxy-slot identifier for diagnosis and connection-level accounting; metrics must not use proxy-slot, device, IP, session, route, grant, or user identifiers as attributes.

Logs and traces must not contain request/response bodies, full URLs or query strings, raw headers, cookies, target authorization, control bearer tokens, proxy passwords, credential verifiers, provider credentials, or raw vendor responses. Tunnel telemetry contains connection metadata only because application traffic remains encrypted. Provider, provider-override, health, cost, routing-score, soft-overflow, failure-class, and hard-capacity circuit diagnostics are restricted to authorized telemetry and company-facing dashboard views.

## Consumer checklist

- Use a dedicated access grant per independently revocable workload.
- Store the one-time credential password immediately and separately from ordinary configuration.
- Configure both the endpoint and opaque credential; do not embed routing policy in either.
- Use remote/provider DNS for SOCKS5.
- Rotate credentials during the renewal window and revoke suspected credentials immediately.
- Handle target redirects and end-to-end retries in the application.
- Prefer declared geography and carrier constraints; use `providerOverride` only for a genuine vendor constraint, never to request a device or exit IP.
- Confirm collection is authorized and compliant.
