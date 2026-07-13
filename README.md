# Profound Proxy Router

An offline-first TypeScript forward proxy that presents one authenticated HTTP/HTTPS proxy endpoint over two provider models:

- rotating Bright Data residential proxies;
- persistent, device-backed Proxidize mobile proxies.

The default `mock` mode starts local simulations of both provider contracts. It does not require vendor accounts, credentials, or payments.

The control plane is defined with Effect `HttpApi` and implemented with `HttpApiBuilder`. The same declaration serves the REST API, generates the OpenAPI 3.1 contract, and powers interactive Swagger documentation. OpenTelemetry instruments control requests, proxied HTTP traffic, `CONNECT` tunnels, latency, outcomes, and route rotations.

## Requirements

- Node.js 22.13 or newer
- TypeScript 7
- pnpm 10

## Run locally

```sh
pnpm install
CONTROL_API_TOKEN=change-me pnpm dev
```

The forward proxy listens on `127.0.0.1:8080`; the control API listens on `127.0.0.1:8081`. Configuration is read from environment variables—the service does not automatically load `.env` files. For a larger configuration, export the values in `.env.example` using your preferred process manager or shell tooling.

Generated API assets are available without administrator authentication:

- OpenAPI 3.1 JSON: `http://127.0.0.1:8081/openapi.json`
- Swagger UI: `http://127.0.0.1:8081/docs`

Create a rotating residential route:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "public-us",
    "kind": "residential",
    "targeting": { "country": "US", "postalCode": "10001" },
    "rotation": { "mode": "per_request" }
  }'
```

The response includes a `proxyUrl` exactly once. Use it with an HTTP client:

```sh
curl --proxy 'http://ROUTE_ID:ROUTE_TOKEN@127.0.0.1:8080' http://example.test/
```

Create a persistent mobile route matching a simulated New York T-Mobile device:

```sh
curl -sS http://127.0.0.1:8081/v1/routes \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "authenticated-ny",
    "kind": "mobile",
    "targeting": { "country": "US", "region": "NY", "carrier": "T-Mobile" },
    "rotation": { "mode": "manual" }
  }'
```

Rotate a route with `POST /v1/routes/:id/rotate`. Inspect redacted route state with `GET /v1/routes/:id`, and provider readiness with `GET /v1/providers/health`.

## Security behavior

- The control API requires `CONTROL_API_TOKEN` on every `/v1` request.
- Forward-proxy routes use generated Basic-auth credentials; only a scrypt hash is persisted.
- Target ports are restricted to `80,443` by default.
- Provider credentials, route tokens, authorization headers, cookies, and URL query strings are omitted or redacted in logs.
- OpenTelemetry attributes include route/provider identifiers, target host/port, status, and duration, but exclude credentials and URL query strings.
- Provider failures fail closed. The service never sends target traffic directly as a fallback.

Change the default administrator token before exposing either listener beyond localhost.

## Verification

```sh
pnpm check
pnpm test
pnpm build
```

All normal tests are local and deterministic. `pnpm test:live` is reserved for a later credentialed pass and is skipped unless `RUN_LIVE_PROXY_TESTS=1` is explicitly set.

## Live mode

Set `PROVIDER_MODE=live` and supply the Bright Data and Proxidize variables in `.env.example`. Live mode uses the documented provider endpoints, but has not been credential-verified in this initial offline implementation.

## OpenTelemetry

Telemetry is exporter-neutral and uses standard `OTEL_*` environment variables. No endpoint is contacted unless an exporter is explicitly configured. For an OTLP HTTP collector:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_TRACES_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
pnpm dev
```

The Effect runtime is bridged to the global OpenTelemetry provider through `@effect/opentelemetry`, so spans created by Effect handlers and the raw Node proxy data plane share the same exporter configuration.
