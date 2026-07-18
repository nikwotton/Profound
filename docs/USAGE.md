# Consumer guide

This guide covers Profound Proxy Router v0's provider-neutral control plane and its standard HTTP/HTTPS and SOCKS5 data plane. Deployment, monitoring, and incident procedures are in the [operations guide](OPERATIONS.md).

## Concepts

- A **route profile** stores stable workload requirements. It contains no protocol choice, session or rotation policy, caller secret, or provider secret; the optional `providerOverride` is its sole provider constraint.
- An **access grant** is the credential, ownership, and revocation boundary for one independently revocable workload. It does not reserve a provider, slot, device, or IP.
- A **credential** authenticates one access grant. Its opaque username is stable for that credential; its password is shown only when issued or rotated.
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
    "isTargetAuthenticated": true,
    "allowConnectionRetry": false
  }'
```

The `201` response contains only the new identifier:

```json
{ "profileId": "PROFILE_ID" }
```

Issue an access grant and its initial credential:

```sh
curl -sS -X POST http://127.0.0.1:8081/v1/profiles/PROFILE_ID/grants \
  -H 'Authorization: Bearer change-me'
```

The `201` response contains redacted `grant` metadata, credential-free `endpoints`, and a `credential` with `credentialId`, opaque `username`, and one-time `password`. Store the password immediately in a secret manager. It cannot be retrieved later. Do not construct a username from a profile or grant ID.

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

The client sends an absolute-form request target. Profound removes proxy-only authentication and preserves target method, path, query, headers, body, statuses, and redirects.

SOCKS5 with provider-side DNS:

```sh
curl --socks5-hostname '127.0.0.1:1080' \
  --proxy-user 'OPAQUE_USERNAME:ONE_TIME_PASSWORD' \
  https://example.com/
```

V0 supports authenticated SOCKS5 TCP `CONNECT`; it rejects unauthenticated negotiation, `BIND`, and `UDP ASSOCIATE`.

## Route profile contract

The committed [OpenAPI contract](../openapi/profound-control-api.v0.6.0.json) is authoritative.

| Field                   | Required    | Behavior                                                                                                                |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `customerId`            | Yes         | Non-empty attribution value.                                                                                            |
| `geography.countryCode` | Conditional | Optional two-letter ISO code, normalized to uppercase; required for authenticated targets.                              |
| `geography.regionCode`  | No          | State or region constraint.                                                                                             |
| `geography.city`        | Conditional | Required with country when `isTargetAuthenticated` is true.                                                             |
| `carrier`               | No          | Carrier constraint.                                                                                                     |
| `providerOverride`      | No          | `bright_data`, `proxidize`, or `null`; constrains routing without bypassing compatibility, safety, health, or capacity. |
| `isTargetAuthenticated` | Yes         | Declares whether the target session is authenticated; controls provider-class preference and identity requirements.     |
| `allowConnectionRetry`  | Yes         | Permits safe pre-commit connection-establishment retries.                                                               |

Unknown fields are rejected. In particular, profiles do not accept `name`, `protocol`, `allowedProtocols`, `targeting`, `rotation`, `session`, `retryPolicy`, `provider`, `principalId`, or `userId`.

Authenticated targets require exact country and city targeting. They exhaust compatible device-backed candidates before residential candidates; device-backed soft saturation does not open residential fallback. Unauthenticated targets normally prefer residential candidates for cost, but residential soft saturation promotes a compatible unsaturated device-backed candidate ahead of saturated residential overflow. Complete profile responses include `providerOverride: null` when no override is set; chosen-provider details, pricing, and health remain internal.

Replace the stable requirements with `PUT /v1/profiles/{id}`. New connections use the replacement; established requests and tunnels continue under the policy with which they opened.

## Access grants and credentials

Access grants are reusable credential scopes, not target-session or provider-assignment boundaries. Every new upstream connection independently scores compatible providers and, for Proxidize, compatible proxy slots. The router atomically claims the selected slot's active load before establishment. Multiple grants, callers, customers, and connections may share a slot. The assignment lasts only for that connection; grant or credential revocation has no durable assignment to release.

| Operation                                | Endpoint                                                 |
| ---------------------------------------- | -------------------------------------------------------- |
| Create/list profiles                     | `POST /v1/profiles`, `GET /v1/profiles`                  |
| Inspect/replace/remove profile           | `GET`, `PUT`, `DELETE /v1/profiles/{id}`                 |
| Create/list grants                       | `POST`, `GET /v1/profiles/{id}/grants`                   |
| Inspect/revoke grant                     | `GET`, `DELETE /v1/grants/{grantId}`                     |
| Rotate credential                        | `POST /v1/grants/{grantId}/credentials/rotate`           |
| Replace suspected-compromised credential | `POST /v1/grants/{grantId}/credentials/emergency-rotate` |
| Inspect credential metadata              | `GET /v1/grants/{grantId}/credentials/{credentialId}`    |
| Revoke one credential                    | `DELETE /v1/grants/{grantId}/credentials/{credentialId}` |

Credentials have a fixed 30-day lifetime. `renewalDueAt` is seven days before expiry. Routine rotation leaves prior usable credentials in bounded overlap for at most 72 hours or until original expiry. Emergency rotation invalidates prior credentials immediately. Profile or grant removal blocks new use while established traffic is allowed to finish.

Profile, grant, and credential list/read responses never include passwords, verifiers, provider credentials, device identifiers, or proxy URLs with embedded credentials.

## Routing and retry behavior

Provider selection and provider-specific rotation are internal implementation policy. Consumers declare stable requirements, not mechanisms.

`providerOverride` is the one deliberate exception: set it to `bright_data` or `proxidize` only when a workload must constrain the vendor, or leave it `null`/omit it for ordinary provider-neutral routing. An override never bypasses protocol, geography, safety, health, hard-capacity, or circuit checks. If the named provider cannot satisfy the profile, the control plane returns `provider_override_unsatisfied`; the data plane does not fall back to another provider.

Within the applicable provider-preference tier, candidates receive a versioned score from reliability, nonlinear capacity headroom, proxy-controlled establishment performance, expected cost, and stability. The router randomly selects within five points of the best score, weighted by score squared, so similarly qualified traffic is distributed without ignoring material quality differences. A candidate at its soft capacity limit remains an overflow option rather than being rejected. For authenticated traffic, device-backed saturation changes ordering only inside that class. For unauthenticated traffic, residential saturation promotes a compatible unsaturated device-backed candidate ahead of saturated residential overflow.

- Unauthenticated operations use fresh residential candidates.
- Authenticated operations prefer device-backed providers, require exact-city routing, and keep a connection on its selected upstream for its lifetime. The preference supplies a controlled, coherent identity; device and IP continuity across connections is best effort rather than guaranteed.
- Bright Data remains eligible for authenticated targets when it satisfies all constraints; Proxidize remains subject to inventory and capacity.
- Repeated proxy-controlled pre-commit establishment/capacity failures and provider-reported hard limits open a shared capacity circuit. The initial cooldown is 60 seconds, repeated openings back off, and one half-open probe closes the circuit after success.
- `allowConnectionRetry` only permits retries before target request or tunnel bytes are committed.
- Target HTTP responses, provider-authentication failures, and failures after commit are not hidden by failover.
- No request ever falls back to the router's direct Internet connection.

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

The Effect error discriminator `_tag` may also appear in the JSON representation. `401` means the control credential is missing or invalid; `404` intentionally covers absent, revoked, or non-owned resources; `503` means the required service capability is unavailable. Data-plane authentication failures return HTTP `407` or SOCKS5 authentication failure.

## Destination and transport safety

- Explicit loopback, private, link-local, multicast, reserved, metadata, and special-use IP literals are rejected.
- Domains remain intact for provider-side DNS. Local DNS is diagnostic only and cannot reroute the request.
- Verified provider-side private resolution is rejected. Where an opaque provider supplies no resolution evidence, safety is best effort and the missing evidence is recorded internally.
- Target URL credentials and credentials in `CONNECT` authorities are rejected.
- Target ports default to `80` and `443`; operators may deliberately allow more public TCP ports.
- Request and response bodies stream with backpressure.

## Privacy and logging

Operational telemetry may include timestamps, request and correlation IDs, profile/grant/customer identifiers, protocol, target hostname and port, target method and status for plain HTTP, provider class and provider identifier in internal telemetry only, normalized outcome, duration, byte counts, retry count, and sanitized assignment evidence. Internal logs and traces may carry a proxy-slot identifier for diagnosis and connection-level accounting; metrics must not use proxy-slot, device, IP, session, route, grant, or user identifiers as attributes.

Logs and traces must not contain request/response bodies, full URLs or query strings, raw headers, cookies, target authorization, control bearer tokens, proxy passwords, credential verifiers, provider credentials, or raw vendor responses. Tunnel telemetry contains connection metadata only because application traffic remains encrypted. Provider, provider-override, health, cost, routing-score, soft-overflow, failure-class, and hard-capacity circuit diagnostics are restricted to internal telemetry and the internal dashboard.

## Consumer checklist

- Use a dedicated access grant per independently revocable workload.
- Store the one-time credential password immediately and separately from ordinary configuration.
- Configure both the endpoint and opaque credential; do not embed routing policy in either.
- Use remote/provider DNS for SOCKS5.
- Rotate credentials during the renewal window and revoke suspected credentials immediately.
- Handle target redirects and end-to-end retries in the application.
- Prefer declared geography and carrier constraints; use `providerOverride` only for a genuine vendor constraint, never to request a device or exit IP.
- Confirm collection is authorized and compliant.
