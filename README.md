# Profound Proxy Router

Profound Proxy Router is a provider-neutral HTTP, HTTPS, and SOCKS5 gateway over Bright Data residential proxies and Proxidize device-backed mobile proxies. Proxy-aware clients keep the original destination URL, method, headers, query string, body, redirect behavior, and TLS behavior; they change only their configured proxy endpoint and credentials.

V0 includes:

- native HTTP forwarding, HTTPS `CONNECT`, and SOCKS5 TCP `CONNECT`;
- reusable, secret-free route profiles and independently revocable access grants;
- deterministic least-loaded candidate selection, safe pre-commit retry, and TTL-backed per-connection proxy-slot leases without a global selection lock;
- mock providers in an entirely local runtime and personal SST stages that require no vendor account or payment;
- ephemeral in-memory persistence for local review and DynamoDB persistence for deployed stages;
- health aggregation, signed external canaries, alerts, usage accounting, and a company-facing dashboard;
- an AWS deployment built with SST and separate ECS Fargate services.

Provider credentials and endpoints never leave the service. Target traffic never falls back to a direct Internet connection.

The deployed control API, proxy gateways, and dashboard are company-wide services for authorized users and workloads. They remain on approved private company networks; they are not limited to the team that operates the router and are not exposed as public Internet applications.

## Documentation

| Audience                                   | Guide                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Application developers and proxy consumers | [Consumer guide](docs/USAGE.md)                                            |
| Product and architecture reviewers         | [Demo vs production capability map](docs/CAPABILITIES.md)                  |
| Platform operators and on-call engineers   | [Operations guide](docs/OPERATIONS.md)                                     |
| Contributors and maintainers               | [Development guide](docs/DEVELOPMENT.md)                                   |
| Repository administrators                  | [Repository and release settings](docs/repository-and-release-settings.md) |
| Control-plane client generators            | [OpenAPI 3.1 contract](openapi/profound-control-api.v0.10.0.json)          |
| Configuration and secret sources           | [Configuration audit](docs/CONFIGURATION.md)                               |

The OpenAPI contract covers management operations. Forwarding remains native HTTP proxy and SOCKS5 protocol traffic, so consumers do not wrap requests in a Profound-specific envelope.

The [capability map](docs/CAPABILITIES.md) distinguishes what the zero-account `pnpm demo` directly proves from the durability, observability, accounting, health, scaling, and release services used by a production deployment.

## Requirements

- Node.js 22.13 or newer
- pnpm 11.9.0
- AWS credentials for SST development and deployment only
- Docker when building or deploying container images only

## Install

Installing dependencies does not start the service:

```sh
pnpm install
```

This command does not start a server. Run `pnpm sst install` separately only when working with SST; it installs SST's generated infrastructure providers and types without starting a server.

`pnpm build` creates the production application artifact without tests. Production container builds also omit local provider simulators, demos, and controlled integration targets; those are included only in explicit development and test workflows.

## Run the offline demo

Start the complete single-process local stack and watch it exercise the main usage flows:

```sh
pnpm demo
```

No AWS, Axiom, Bright Data, Proxidize, Docker, or other external account is needed. The command starts the real control API, HTTP/HTTPS forward proxy, SOCKS5 proxy, usage ledger, accounting worker, and analytics API with in-memory persistence and local provider simulators. It demonstrates readiness, residential rotation, mobile affinity, HTTP forwarding, a pre-commit `CONNECT` retry/failover, SOCKS5 tunnelling, credential lifecycle, and the complete operation → immutable attempt records → rollup → analytics-query path. The output includes customer/job/provider attribution, bytes, latency, retry/failover and outcome metrics, Bright Data per-GiB cost, and Proxidize device-month cost allocation. In an interactive terminal, press Enter to run each step individually. Each step prints its live sanitized request, response, selected mock identity metadata, and protocol details; request bodies, URL queries, headers, cookies, authorization, and credentials remain absent or redacted. Redirected output and `pnpm demo -- --no-interactive` run the walkthrough continuously without prompts.

After the walkthrough, the servers stay available for inspection:

| Interface                | Address                      |
| ------------------------ | ---------------------------- |
| HTTP/HTTPS forward proxy | `127.0.0.1:8080`             |
| SOCKS5 proxy             | `127.0.0.1:1080`             |
| Control API              | `http://127.0.0.1:8081`      |
| Swagger UI               | `http://127.0.0.1:8081/docs` |
| Analytics and dashboard  | `http://127.0.0.1:8083`      |

Use the local-only control token `change-me` in Swagger UI. Press Ctrl-C to stop the demo and discard its ephemeral data. To start the same local stack without the scripted walkthrough, run `pnpm dev:local`.

## Start with SST

Start a personal development stage. SST provisions DynamoDB and supporting AWS resources, then runs the application services locally with injected configuration and mock providers:

```sh
pnpm sst:dev --stage yourname-dev
```

| Interface                | Address                              |
| ------------------------ | ------------------------------------ |
| HTTP/HTTPS forward proxy | `127.0.0.1:8080`                     |
| SOCKS5 proxy             | `127.0.0.1:1081`                     |
| Control API              | `http://127.0.0.1:8081`              |
| Swagger UI               | `http://127.0.0.1:8081/docs`         |
| OpenAPI JSON             | `http://127.0.0.1:8081/openapi.json` |

Personal stages supply the development control token `change-me`; no `.env` file or vendor secret is required. SST prints every service address, including the internal dashboard at `http://127.0.0.1:8083`.

Create a reusable provider-neutral profile:

```sh
curl -sS http://127.0.0.1:8081/v1/profiles \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "customer-a",
    "geography": { "countryCode": "US" },
    "allowConnectionRetry": true
  }'
```

The response is `{ "profileId": "..." }`. Issue an independently revocable access grant for that profile:

```sh
curl -sS -X POST http://127.0.0.1:8081/v1/profiles/PROFILE_ID/grants \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "none" }'
```

Use `sessionMode: "none"` for a stateless credential or `sessionMode: "managed"` for a managed logical session. The field is required; omission is invalid. Save the returned `credential.username` and one-time `credential.password`; the password cannot be retrieved later. `endpoints` contains credential-free gateway addresses. Use them with an existing proxy-aware client:

```sh
curl --proxy 'http://127.0.0.1:8080' \
  --proxy-user 'OPAQUE_CREDENTIAL_USERNAME:ONE_TIME_PASSWORD' \
  https://example.com/
```

See [docs/USAGE.md](docs/USAGE.md) before integrating. It documents credential handling, all profile fields, protocol behavior, rotation, retries, errors, and lifecycle operations.

## Verify

```sh
pnpm verify
```

Normal tests use local providers and controlled recipients. Live vendor checks and deployed AWS checks are explicitly gated; see the [development guide](docs/DEVELOPMENT.md#test-suites).

## V0 boundaries

V0 supports HTTP forwarding, HTTPS and SOCKS5 TCP tunnels, Bright Data residential service, Proxidize Per Proxy mobile service, AWS/SST deployment, and company cost attribution. It intentionally does not include TLS interception, SOCKS5 `BIND`, SOCKS5 `UDP ASSOCIATE`, direct-connection fallback, a public-Internet dashboard, end-customer invoicing, or multi-cloud deployment.

Operate the service only for authorized collection and access that complies with target-site, provider, and applicable legal requirements.
