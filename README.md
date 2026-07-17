# Profound Proxy Router

Profound Proxy Router is a provider-neutral HTTP, HTTPS, and SOCKS5 gateway over Bright Data residential proxies and Proxidize device-backed mobile proxies. Proxy-aware clients keep the original destination URL, method, headers, query string, body, redirect behavior, and TLS behavior; they change only their configured proxy endpoint and credentials.

V0 includes:

- native HTTP forwarding, HTTPS `CONNECT`, and SOCKS5 TCP `CONNECT`;
- reusable, secret-free route profiles and independently revocable access grants;
- capability-aware provider selection, retry, rotation, and device affinity;
- local provider simulators that require no vendor account or payment;
- SQLite for local state and DynamoDB for deployed state;
- health aggregation, signed external canaries, alerts, usage accounting, and an internal dashboard;
- an AWS deployment built with SST and separate ECS Fargate services.

Provider credentials and endpoints never leave the service. Target traffic never falls back to a direct Internet connection.

## Documentation

| Audience | Guide |
| --- | --- |
| Application developers and proxy consumers | [Consumer guide](docs/USAGE.md) |
| Platform operators and on-call engineers | [Operations guide](docs/OPERATIONS.md) |
| Contributors and maintainers | [Development guide](docs/DEVELOPMENT.md) |
| Repository administrators | [Repository and release settings](docs/repository-and-release-settings.md) |
| Control-plane client generators | [OpenAPI 3.1 contract](openapi/profound-control-api.v0.5.0.json) |
| Complete environment reference | [.env.example](.env.example) |

The OpenAPI contract covers management operations. Forwarding remains native HTTP proxy and SOCKS5 protocol traffic, so consumers do not wrap requests in a Profound-specific envelope.

## Requirements

- Node.js 22.13 or newer
- pnpm 10.12.1
- Docker and AWS credentials only when deploying with SST

## Install

Installing dependencies does not start the service:

```sh
pnpm install
pnpm sst install
```

The second command installs SST's generated infrastructure providers and types. Neither command starts a server.

## Start locally

Start the combined proxy and control plane in offline mock mode:

```sh
pnpm dev
```

| Interface | Address |
| --- | --- |
| HTTP/HTTPS forward proxy | `127.0.0.1:8080` |
| SOCKS5 proxy | `127.0.0.1:1080` |
| Control API | `http://127.0.0.1:8081` |
| Swagger UI | `http://127.0.0.1:8081/docs` |
| OpenAPI JSON | `http://127.0.0.1:8081/openapi.json` |

Loopback-only mock mode supplies the development control token `change-me` and trusted principal `local-dev`.

Create a route and its first access grant:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "public-us",
    "targeting": { "country": "US", "postalCode": "10001" },
    "customerId": "customer-a",
    "isAuthenticated": false,
    "shouldRetry": true
  }'
```

Save `proxyUrls.http` or `proxyUrls.socks5` from the response: each contains a one-time access-grant secret. Use the HTTP URL with an existing proxy-aware client:

```sh
curl --proxy 'http://ACCESS_GRANT_ID:ACCESS_GRANT_TOKEN@127.0.0.1:8080' \
  https://example.com/
```

See [docs/USAGE.md](docs/USAGE.md) before integrating. It documents credential handling, all route fields, protocol behavior, rotation, retries, errors, and lifecycle operations.

## Verify

```sh
pnpm format:check
pnpm check
pnpm lint
pnpm openapi:check
pnpm test
pnpm build
```

Normal tests use local providers and controlled recipients. Live vendor checks and deployed AWS checks are explicitly gated; see the [development guide](docs/DEVELOPMENT.md#test-suites).

## V0 boundaries

V0 supports HTTP forwarding, HTTPS and SOCKS5 TCP tunnels, Bright Data residential service, Proxidize Per Proxy mobile service, AWS/SST deployment, and internal usage attribution. It intentionally does not include TLS interception, SOCKS5 `BIND`, SOCKS5 `UDP ASSOCIATE`, direct-connection fallback, a public dashboard, end-customer invoicing, or multi-cloud deployment.

Operate the service only for authorized collection and access that complies with target-site, provider, and applicable legal requirements.
