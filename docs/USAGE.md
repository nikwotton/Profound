# Consumer guide

This guide is for applications, users, and service owners that create proxy routes or send traffic through Profound Proxy Router v0. Platform deployment, monitoring, and incident procedures are in the [operations guide](OPERATIONS.md).

## Concepts

- A **route profile** is reusable policy: allowed protocols, geography, rotation, session, retry behavior, and attribution. It contains no caller or provider secret.
- An **access grant** gives one authenticated principal permission to use one route. Each grant has its own credentials and, for device-backed routing, its own exclusive device lease.
- The **control plane** creates and manages routes and grants over JSON/HTTP.
- The **data plane** accepts standard HTTP proxy and SOCKS5 traffic. It does not accept a Profound-specific request envelope.
- The **target** or **recipient** is the original destination server.

The control bearer token and the access-grant credential are different secrets:

- `Authorization: Bearer ...` authenticates a trusted principal to the control plane.
- `Proxy-Authorization: Basic ...` or SOCKS5 username/password authenticates an access grant to the data plane.
- An `Authorization` header inside a plain HTTP request or an HTTPS tunnel still belongs to the target site and is forwarded unchanged.

## Endpoints

Obtain these values from the platform operator:

| Value                | Local default              | Purpose                                   |
| -------------------- | -------------------------- | ----------------------------------------- |
| Control API base URL | `http://127.0.0.1:8081`    | Route and grant management                |
| Control bearer token | `change-me`                | Local loopback mock mode only             |
| HTTP/HTTPS proxy     | `http://127.0.0.1:8080`    | Plain HTTP forwarding and HTTPS `CONNECT` |
| SOCKS5 proxy         | `socks5h://127.0.0.1:1080` | TCP `CONNECT` with provider-side DNS      |

Deployed endpoints are internal. The forward proxy normally uses TLS from the client to Profound and therefore starts with `https://`. SOCKS5 is unencrypted and must remain on the trusted private network.

## Quick start

### 1. Create a route

This route uses a fresh residential candidate for each logical request and allows all three client protocols:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "public-us",
    "allowedProtocols": ["http", "https", "socks5"],
    "targeting": {
      "country": "US",
      "postalCode": "10001"
    },
    "customerId": "customer-a",
    "isAuthenticated": false,
    "shouldRetry": true
  }'
```

The `201` response contains:

- `route`: the persisted, secret-free route profile;
- `accessGrant`: the initial grant owned by the authenticated control principal;
- `credential`: redacted lifecycle metadata, not the token;
- `proxyUsername`: the access-grant ID;
- `proxyUrls.http` and `proxyUrls.socks5`: complete URLs containing the secret token.

The token is returned only inside the proxy URLs at grant issuance or credential rotation. Store one URL immediately in a secret manager. It cannot be retrieved later.

### 2. Send HTTPS through the HTTP proxy

```sh
curl --proxy 'http://ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN@127.0.0.1:8080' \
  https://example.com/
```

The client sends `CONNECT example.com:443` to Profound. Profound asks the selected upstream proxy to establish the connection and then relays bytes. The TLS session is between the client and `example.com`; Profound and the upstream proxy can observe connection metadata but cannot read or alter the encrypted path, headers, query, body, status, or redirect without a separately trusted interception certificate. V0 performs no TLS interception.

The recipient sees the selected provider exit IP, because the provider creates the recipient-side TCP connection. It does not see the caller's source IP at the network layer.

### 3. Send plain HTTP through the HTTP proxy

```sh
curl --proxy 'http://ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN@127.0.0.1:8080' \
  http://example.com/
```

For plain HTTP, the client sends an absolute-form request target such as `GET http://example.com/ HTTP/1.1`. Profound can forward the method, destination URL, headers, query, and streaming body. It removes proxy-only authentication before forwarding. The recipient receives a normal origin-form request from the selected provider exit.

Target statuses, including redirects, `429`, and `5xx`, are returned unchanged. The caller decides whether to follow a redirect; a followed redirect is a new proxy operation.

### 4. Send traffic through SOCKS5

```sh
curl --socks5-hostname '127.0.0.1:1080' \
  --proxy-user 'ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN' \
  https://example.com/
```

Use remote-DNS mode (`socks5h://` or curl's `--socks5-hostname`) so the destination domain is preserved for the provider. SOCKS5 traffic is an opaque TCP tunnel. V0 supports username/password authentication and TCP `CONNECT`; it rejects unauthenticated negotiation, `BIND`, and `UDP ASSOCIATE`.

## Route profile reference

The committed [OpenAPI contract](../openapi/profound-control-api.v0.5.0.json) is authoritative for JSON shapes. The following table explains the behavioral contract.

| Field                     | Required    | V0 behavior                                                                                                                                                  |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                    | Yes         | Non-empty operator-readable name.                                                                                                                            |
| `allowedProtocols`        | No          | Non-empty subset of `http`, `https`, `socks5`; defaults to all three.                                                                                        |
| `targeting.country`       | Yes         | Two-letter ISO country code, normalized to uppercase.                                                                                                        |
| `targeting.region`        | No          | Provider-specific state or region.                                                                                                                           |
| `targeting.city`          | Conditional | Required when `isAuthenticated` is true.                                                                                                                     |
| `targeting.postalCode`    | No          | Bright Data ZIP routing requires `US` and exactly five digits.                                                                                               |
| `targeting.asn`           | No          | Positive integer; unsupported by Proxidize routes.                                                                                                           |
| `targeting.carrier`       | No          | Provider-specific carrier name.                                                                                                                              |
| `rotation`                | No          | Defaults to `per_request` for unauthenticated routes and `manual` for authenticated routes.                                                                  |
| `session`                 | No          | Defaults to `none` for per-request rotation and sticky geographic continuity otherwise.                                                                      |
| `customerId`              | Yes         | Non-empty attribution value. V0 does not independently authorize this free-form value.                                                                       |
| `isAuthenticated`         | Yes         | Caller-declared workload policy used for provider preference and exact-city requirements. It does not make either provider technically ineligible by itself. |
| `shouldRetry`             | Yes         | Enables eligible pre-commit establishment retries.                                                                                                           |
| `retryPolicy.maxAttempts` | No          | Integer from 1 to 6; deployment default is 4.                                                                                                                |
| `forceProvider`           | No          | `bright_data` or `proxidize`; prevents cross-provider fallback and is intended for controlled rollout/debugging.                                             |

The control principal becomes the profile's `userId` and initial grant owner. Callers cannot choose `principalId` or `userId` in a request body.

Profiles have no update endpoint in v0. Create a new route when policy, targeting, or attribution must change, migrate grants, and revoke the old route.

### Targeting constraints

- Authenticated routes require an exact city. Every attempted candidate must guarantee or verify that city before the connection is exposed.
- Proxidize routes currently require country `US` and reject postal-code and ASN targeting.
- Mock Proxidize inventory guarantees its configured city. Live Proxidize defaults to exact-city `unsupported` until the operator has established a vendor guarantee.
- Bright Data supports country, region, city, US ZIP, ASN, and carrier targeting through generated upstream credentials.
- A forced provider that cannot satisfy the requested capabilities fails closed.

### Rotation policies

Per request:

```json
{ "rotation": { "mode": "per_request" } }
```

Profound selects a new service-controlled candidate session for every logical operation. Proxidize does not support this policy.

Interval:

```json
{ "rotation": { "mode": "interval", "intervalSeconds": 900 } }
```

The minimum is 60 seconds. Bright Data keeps the generated provider session stable within the interval. For device-backed routes, Profound initiates rotation while retaining route constraints and exclusive lease ownership.

Manual:

```json
{ "rotation": { "mode": "manual" } }
```

The candidate remains stable until `POST /v1/routes/{id}/rotate`, a qualifying failure, lease expiry/release, or provider-initiated change observable under the provider contract. Route rotation returns `202`; poll `GET /v1/routes/{id}` until `status` is `ready` or `failed`.

### Session policies

No sticky state:

```json
{ "session": { "mode": "none" } }
```

Sticky state:

```json
{
  "session": {
    "mode": "sticky",
    "id": "caller-session-42",
    "requireGeographicContinuity": true
  }
}
```

Sticky sessions are incompatible with per-request rotation. For device-backed routes, the lease is exclusive to the access grant plus the optional session ID. Different grants never share a device lease, and credential rotation does not change the lease. Activity renews the lease; it expires after a service-wide 15 minutes with no active connection or recent activity, or it can be released explicitly.

Route affinity is independent of target-site authentication and cookies. Profound does not inspect cookies or infer authentication from request headers or bodies.

### Example: persistent authenticated collection

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "authenticated-new-york",
    "targeting": {
      "country": "US",
      "region": "NY",
      "city": "New York",
      "carrier": "T-Mobile"
    },
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

## Routing and retries

- Unauthenticated routes prefer compatible residential providers, then compatible device-backed providers. With the v0 adapters, Bright Data is preferred before Proxidize.
- Authenticated routes prefer compatible device-backed providers, then compatible residential providers. This is a routing preference, not a blanket provider restriction.
- Within a provider class, the current provider is tried first and remaining providers use cost rank.
- An operation tries at most two peers/devices per provider and considers at most three compatible providers.
- The default four attempts therefore cover at most two candidates in each of the two v0 providers.
- `forceProvider` permits alternate candidates within that provider but prohibits cross-provider fallback.
- Each candidate establishment attempt has at most 10 seconds; the complete establishment sequence has at most 30 seconds.
- Profound performs no in-request backoff.

Plain HTTP is retryable only before application request bytes have reached an upstream. Provider authentication errors and target HTTP responses are not hidden by failover. HTTPS and SOCKS5 may retry only before the upstream tunnel is established. Once response or tunnel bytes have been delivered, any failure is surfaced to the caller.

Exact device or IP continuity is not a failover guarantee. An authenticated attempt may move only to a candidate that preserves the exact city and every other route constraint.

## Access-grant lifecycle

Every proxy username is an access-grant ID, not a route ID. Every request resolves the current grant and route records, so revocation and expiry take effect without embedding policy or vendor credentials in the token.

| Operation                      | Endpoint                                                        | Effect                                                                                |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Create route and initial grant | `POST /v1/routes`                                               | Returns one-time proxy URLs.                                                          |
| List routes                    | `GET /v1/routes`                                                | Returns secret-free profiles available to trusted control-plane callers.              |
| Get route                      | `GET /v1/routes/{id}`                                           | Returns current route status.                                                         |
| Create another grant           | `POST /v1/routes/{id}/access-grants`                            | Returns a separate one-time credential for the caller.                                |
| List caller's grants           | `GET /v1/routes/{id}/access-grants`                             | Returns redacted metadata only.                                                       |
| Rotate credential              | `POST /v1/access-grants/{grantId}/credentials/rotate`           | Issues a replacement; old credential overlaps for at most 72 hours.                   |
| Emergency rotate               | `POST /v1/access-grants/{grantId}/credentials/emergency-rotate` | Invalidates all prior credentials immediately and returns a replacement.              |
| Revoke grant                   | `DELETE /v1/access-grants/{grantId}`                            | Blocks new use; established traffic is allowed to finish.                             |
| Emergency revoke grant         | `POST /v1/access-grants/{grantId}/emergency-revoke`             | Blocks new use and terminates only this grant's established traffic.                  |
| Release device lease           | `POST /v1/access-grants/{grantId}/release`                      | Terminates lease-bound connections and frees the device.                              |
| Rotate route exit              | `POST /v1/routes/{id}/rotate`                                   | Starts provider-supported rotation and returns `202`.                                 |
| Revoke route                   | `DELETE /v1/routes/{id}`                                        | Blocks all grants for new traffic; established traffic is allowed to finish.          |
| Emergency revoke route         | `POST /v1/routes/{id}/emergency-revoke`                         | Blocks the route and terminates all established traffic for it.                       |
| Provider capabilities          | `GET /v1/providers`                                             | Returns protocols, geography, sessions, rotation, DNS, pricing, and usage dimensions. |
| Provider health                | `GET /v1/providers/health`                                      | Returns normalized provider health.                                                   |

Credentials have a fixed 30-day lifetime and no idle extension. Metadata sets `renewalDueAt` seven days before expiry. Rotate during that window. A routine rotation keeps the access-grant ID and device lease; prior usable credentials become `overlap` and are revoked after at most 72 hours or their original expiry, whichever comes first.

Treat returned proxy URLs as bearer secrets:

- store them in a secret manager, never source control or ordinary configuration;
- do not place them in logs, metrics, traces, tickets, or screenshots;
- use one grant per principal or independently revocable workload;
- use emergency rotation for suspected disclosure;
- do not deliberately share a grant if per-principal attribution matters.

V0 attributes use to the grant owner but cannot prevent that owner from sharing a credential. Identity-bound data-plane authentication such as mTLS is deferred.

## Control-plane responses and errors

The control API uses JSON and bearer authentication. Its live contract and Swagger UI are available at `/openapi.json` and `/docs`.

| Status | Meaning                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------- |
| `200`  | Read or completed lifecycle operation.                                                                |
| `201`  | Route or grant created; capture the returned proxy URL.                                               |
| `202`  | Rotation accepted; poll route status.                                                                 |
| `400`  | Malformed or incompatible policy. The JSON body contains a normalized code/message.                   |
| `401`  | Missing or invalid control bearer token.                                                              |
| `404`  | Route/grant absent, revoked, or not owned by the principal. Ownership is intentionally not disclosed. |
| `503`  | Required provider/service capability is unavailable.                                                  |
| `500`  | Internal control-plane failure with sanitized output.                                                 |

Data-plane authentication failures return HTTP `407 Proxy Authentication Required` or the SOCKS5 username/password failure response. Upstream establishment failures are normalized to gateway/provider errors without provider credentials or raw vendor responses. Callers should distinguish target HTTP statuses from proxy establishment failures and should apply their own end-to-end retry budget.

## Destination and transport rules

- Only public-Internet destinations are allowed.
- Explicit loopback, private, link-local, multicast, reserved, cloud-metadata, and special-use IP literals are rejected.
- Domain names are preserved for provider-side DNS. Local DNS is best-effort telemetry and cannot reroute or reject the operation.
- Target ports default to `80` and `443`; operators can deliberately allow additional public TCP ports.
- Credentials embedded in a target URL or `CONNECT` authority are rejected.
- Request and response bodies stream with backpressure; there are no application-level full-body size limits.
- The configured stream idle timeout applies after establishment. Client, load-balancer, and target timeouts can be shorter.
- Profound never connects directly to a target when every provider attempt fails.

## Privacy and observability

The service accounts for per-direction bytes and records route, grant owner, customer, provider, outcome, and normalized candidate evidence. It intentionally excludes request/response bodies, raw headers, query strings, cookies, target authorization values, control tokens, access-grant tokens, and provider credentials from logs and traces.

Plain HTTP operational records may include target method, hostname, and status. Tunnel records include only protocol, target host/port, establishment outcome, duration, and bytes; the encrypted application metadata remains opaque.

## Versioning and compatibility

The v0 control API contract version is `0.5.0`. Generate clients from [the committed OpenAPI artifact](../openapi/profound-control-api.v0.5.0.json), not examples in this guide. CI rejects incompatible removals and newly required control-plane inputs against the pull-request base contract.

HTTP proxy and SOCKS5 behavior follows their native protocols. There is no generated SDK requirement for the data plane.

## Consumer checklist

- Obtain the internal control and proxy endpoints from the operator.
- Use a dedicated control identity and access grant per workload.
- Store the one-time returned proxy URL immediately.
- Select remote/provider DNS for SOCKS5.
- Set application timeouts longer than the expected 30-second maximum establishment sequence when retries are enabled.
- Rotate credentials during the renewal window and test emergency rotation/revocation.
- Handle redirects and target retries in the client.
- Never assume the exact IP or device survives failover; rely only on declared route constraints.
- Confirm the collection is authorized and compliant.
