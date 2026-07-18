# Development guide

This guide covers local development, contracts, tests, migrations, and delivery for Profound Proxy Router v0. Consumer behavior is in [USAGE.md](USAGE.md), and production operation is in [OPERATIONS.md](OPERATIONS.md).

## Toolchain

- Node.js 22.13 or newer
- pnpm 10.12.1
- TypeScript 7 for authoritative compilation
- the repository's isolated lint toolchain
- AWS credentials for SST development, deployed tests, and infrastructure changes
- Docker for container image builds and deployments

The compiler/linter version split is intentional. `pnpm check` currently uses TypeScript 7.0.2 as the authoritative compiler, while `pnpm lint` uses the isolated TypeScript 6.0.3 and typescript-eslint 8.64.0 toolchain under `tools/lint`. TypeScript 7.0 does not expose the programmatic compiler API required by type-aware tools such as typescript-eslint, and [Microsoft recommends running TypeScript 6 alongside TypeScript 7 during this transition](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60). TypeScript 6.0.3 is within [typescript-eslint's currently supported TypeScript range](https://typescript-eslint.io/users/dependency-versions/#typescript).

This remains an outstanding toolchain gap pending TypeScript 7.1. Once TypeScript 7.1 provides its new API and typescript-eslint officially supports it, migrate the lint toolchain to the TypeScript 7 API and remove the isolated TypeScript 6 dependency. Until both conditions are met, do not point type-aware ESLint directly at TypeScript 7.

The main compiler requires bracket access for properties supplied only by index signatures. The SST compiler boundary cannot currently enable that rule because SST transitively compiles generated `.sst/platform` TypeScript that does not satisfy it. `skipLibCheck` also remains enabled because current Effect and Vitest/Chai dependency declarations conflict under full declaration checking. Re-evaluate both exceptions when upgrading those dependencies; do not patch generated or third-party sources to satisfy repository policy.

Install dependencies without starting a service:

```sh
pnpm install
```

The repository explicitly allows the required `esbuild` install script and ignores understood optional native build scripts. Resolve new package-manager warnings rather than documenting around them.

## Start and build

Run the self-contained reviewer walkthrough with local provider simulators and ephemeral in-memory persistence:

```sh
pnpm demo
```

In a terminal, the walkthrough waits for Enter before each major step; use `pnpm demo -- --no-interactive` to run all steps continuously. Redirected output is automatically non-interactive, so automation cannot wait on a prompt. The walkthrough leaves its loopback servers running until Ctrl-C. Run `pnpm dev:local` for the same local-only runtime without the walkthrough. Neither command reads cloud, telemetry-exporter, or vendor credentials.

Start a personal SST development stage. SST provisions the supporting AWS resources and starts each application service locally with generated configuration:

```sh
pnpm sst install
pnpm sst:dev --stage yourname-dev
```

Build production JavaScript:

```sh
pnpm build
```

`pnpm build` does not start a server. `dev:service` and the compiled `start` command are internal SST/container entry points; invoking them directly is unsupported.

## Source map

| Path                                | Responsibility                                          |
| ----------------------------------- | ------------------------------------------------------- |
| `src/control-contract.ts`           | Effect HttpApi schemas and the control API contract     |
| `src/control-api.ts`                | Control-plane handlers                                  |
| `src/forward-proxy.ts`              | HTTP forwarding and HTTPS `CONNECT` listener            |
| `src/socks5-proxy.ts`               | SOCKS5 authentication and TCP `CONNECT`                 |
| `src/route-service.ts`              | Route/grant lifecycle and candidate routing             |
| `src/providers/`                    | Provider abstraction and Bright Data/Proxidize adapters |
| `src/simulators/`                   | Offline provider contracts                              |
| `src/store.ts`                      | Persistence interface and credential helpers            |
| `src/dynamo-store.ts`               | Production DynamoDB implementation                      |
| `src/in-memory-route-store.ts`      | Ephemeral local and test persistence adapter            |
| `src/health-aggregator.ts`          | Capability-health evaluation                            |
| `src/public-canary.ts`              | Signed source/geography canary                          |
| `src/status-app.ts`                 | Company-facing dashboard and status/usage APIs          |
| `src/usage-accounting.ts`           | Ledger summarization, cost attribution, reconciliation  |
| `src/alerting.ts`                   | Durable health alerts and webhook delivery              |
| `src/telemetry.ts`, `src/logger.ts` | OTLP instrumentation and redaction                      |
| `infra/providers/aws.ts`            | AWS/SST topology                                        |
| `infra/stage-config.ts`             | Central stage classification and defaults               |
| `config/providers/`                 | Pinned provider contracts and prices                    |
| `migrations/`                       | Current-design migration declarations                   |
| `tests/deployed/spec-matrix.ts`     | Design-decision-to-test inventory                       |

## Quality checks

Run the standard local gate:

```sh
pnpm format:check
pnpm check
pnpm lint
pnpm openapi:check
pnpm test
pnpm build
```

Format changed files with:

```sh
pnpm format
```

`pnpm check` validates application and SST TypeScript. `pnpm lint` uses the checked-in isolated lint environment. `pnpm test` builds first and runs offline Node tests against local simulators and controlled recipients.

## Test suites

| Command                    | Scope                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm test`                | Full offline contract, integration, persistence, health, accounting, and infrastructure-static suite |
| `pnpm test:unit`           | Vitest/Effect unit tests                                                                             |
| `pnpm test:property`       | fast-check property tests                                                                            |
| `pnpm test:release-policy` | Migrations, drain coordination, and release policy                                                   |
| `pnpm test:e2e`            | Stage-independent black-box route, grant, proxy, rotation, and revocation lifecycle                  |
| `pnpm test:live`           | Credential-gated Bright Data and Proxidize smoke tests                                               |
| `pnpm test:aws`            | AWS infrastructure, persistence, telemetry, migration, and restart acceptance suite                  |

Normal tests must stay offline. A new vendor call belongs only in an environment-gated live test.

### Black-box behavioral E2E suite

`pnpm test:e2e` exercises only the caller-visible contract. It creates route profiles and access grants through the control API, sends traffic through the issued HTTP and SOCKS5 endpoints, replaces profile requirements, rotates and revokes credentials, removes profiles, and verifies that invalidated credentials stop working. Cleanup uses the same public APIs.

The suite has no AWS, SSM, SST-stage, datastore, or telemetry dependency. Point it at any compatible mock-mode environment:

```sh
E2E_CONTROL_API_URL='http://127.0.0.1:8081' \
E2E_CONTROL_API_TOKEN='change-me' \
E2E_TARGET_URL='https://example.com/' \
pnpm test:e2e
```

`E2E_CONTROL_API_URL`, `E2E_CONTROL_API_TOKEN`, and `E2E_TARGET_URL` default to the local values and `https://example.com/` shown above, so `pnpm test:e2e` needs no extra configuration for the basic smoke path. Override the target with a controlled recipient for stronger assertions. With an HTTP recipient, mock-provider headers additionally verify exit rotation, exact-city routing, and per-connection proxy-slot selection. With HTTPS, the suite respects TLS opacity and verifies lifecycle operations plus successful traffic before and after rotation. `E2E_EXPECTED_TARGET_STATUS` defaults to `200`.

### Controlled recipient

The destination simulator can configure normal HTTP behavior through query parameters:

- `responseStatus`
- repeated `responseHeader=name:value`
- `responseBody`
- `delayMs` up to 5,000

Its socket-backed form also accepts `connection=respond|close|reset|timeout`. The Lambda form returns `501` for connection-level behavior it cannot faithfully represent. Extend this general simulator before adding one-off network endpoints.

### Live provider smoke tests

Live tests remain skipped unless explicitly enabled and every vendor credential is available:

```sh
RUN_LIVE_PROXY_TESTS=1 \
PROVIDER_MODE=live \
BRIGHT_DATA_CUSTOMER_ID='CUSTOMER_ID' \
BRIGHT_DATA_ZONE='ZONE' \
BRIGHT_DATA_PASSWORD='PASSWORD' \
BRIGHT_DATA_API_KEY='API_KEY' \
PROXIDIZE_API_TOKEN='TOKEN' \
pnpm test:live
```

These tests consume vendor service and may incur cost. Never enable them in a personal developer stage.

### AWS deployment acceptance suite

Use an ephemeral `ci-*` stage. Set its required SST secrets and deploy:

```sh
pnpm sst secret set AxiomIngestToken \
  'AXIOM_DATASET_SCOPED_INGEST_TOKEN' --stage ci-manual
pnpm sst secret set ControlApiToken \
  'REPLACE_WITH_A_LONG_RANDOM_VALUE' --stage ci-manual
pnpm sst secret set HealthAggregatorToken \
  'REPLACE_WITH_ANOTHER_LONG_RANDOM_VALUE' --stage ci-manual
pnpm sst secret set CanarySigningSecret \
  'REPLACE_WITH_A_SIGNING_SECRET' --stage ci-manual

pnpm aws:deploy --stage ci-manual
```

In a second terminal, connect to the private VPC:

```sh
pnpm sst tunnel --stage ci-manual
```

Run the suite with stage secrets and a query-scoped Axiom token:

```sh
DEPLOYED_STAGE=ci-manual \
DEPLOYED_CONTROL_API_TOKEN='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_HEALTH_AGGREGATOR_TOKEN='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_CANARY_SIGNING_SECRET='REPLACE_WITH_THE_STAGE_VALUE' \
DEPLOYED_AXIOM_QUERY_TOKEN='AXIOM_DATASET_SCOPED_QUERY_TOKEN' \
DEPLOYED_RUN_DISRUPTIVE_TESTS=1 \
pnpm test:aws
```

The runner discovers non-secret component metadata from `/sst/profound-proxy-router/ci-manual/deployed-integration`. It verifies the deployed AWS topology, durable persistence and restart behavior, private services, telemetry, migration safety, and environment isolation. Public lifecycle behavior is covered independently by `pnpm test:e2e`.

The disruptive flag forces a proxy ECS replacement to verify DynamoDB-backed credentials and route requirements. Omit it for a non-disruptive run. The suite verifies the fixed v0 30-day telemetry-retention expectation.

Remove the stage when finished:

```sh
pnpm aws:remove --stage ci-manual
```

## OpenAPI workflow

The control plane is defined once with Effect HttpApi schemas. `/openapi.json` serves the live OpenAPI 3.1 document, and [the versioned artifact](../openapi/profound-control-api.v0.6.0.json) is committed for client generation.

After any control schema or endpoint change:

```sh
pnpm openapi:generate
pnpm openapi:check
```

Commit the regenerated artifact with the source change. CI checks exact synchronization and compares the contract with the pull-request base. Incompatible removals or newly required inputs fail compatibility checks.

OpenAPI intentionally excludes the native HTTP proxy and SOCKS5 data planes. Document their behavior in [USAGE.md](USAGE.md) and test it at the protocol level.

## Provider contracts

`config/provider-sources.json` records the source documents. `config/providers/bright-data-v0.json` and `config/providers/proxidize-v0.json` pin the normalized capability, pricing, DNS, and usage contract consumed by the adapters and static checks.

Check source freshness with:

```sh
pnpm provider:freshness
```

When provider documentation changes:

1. verify it against the primary provider documentation;
2. update the pinned normalized contract and source timestamp;
3. update adapter and simulator behavior together;
4. add contract and routing tests;
5. update consumer/operator documentation when behavior changes;
6. keep provider capability distinct from preferred use case or routing order.

Do not turn a routing preference into a technical incompatibility without provider evidence.

## Migrations

The migration manifest is `migrations/manifest.json`. Run declared migrations with:

```sh
pnpm migrate
```

Pull requests declare the migration category through repository labels and template fields. During pre-v0 development, implement only the current design: reset disposable data rather than retaining compatibility code for obsolete shapes. Production-affecting state changes still require an explicit current-design migration and rollback disposition.

## Telemetry development

Personal SST stages use the reviewed development telemetry policy; application processes do not accept an independent local exporter configuration. Preserve the redaction contract. Never add bodies, raw headers, queries, cookies, authorization, access-grant tokens, control tokens, provider secrets, or unsanitized errors to logs/traces. Keep high-cardinality identities out of metric attributes.

## CI and release flow

GitHub Actions is the delivery path:

1. pull-request checks validate formatting, TypeScript, lint, tests, properties, OpenAPI, provider freshness, migration policy, and the deployable image;
2. disposable `ci-*` stages exercise upgrade, migration, deployed behavior, rollback, and cleanup;
3. main releases are serialized and coalesce superseded commits;
4. the immutable image digest validated in staging is promoted unchanged to production;
5. ECS blue/green deploys and the durable drain coordinator protect established tunnels.

The workflow files encode jobs, but branch protection, OIDC, environments, labels, and external integrations must be configured separately. See [repository-and-release-settings.md](repository-and-release-settings.md).

## Documentation changes

- Keep `README.md` as the short repository entry point.
- Put caller-facing protocol and lifecycle behavior in `USAGE.md`.
- Put deployment, configuration, monitoring, and runbooks in `OPERATIONS.md`.
- Put contribution, contracts, and test workflow here.
- Update `CONFIGURATION.md` when an SST secret, deployment input, internal runtime value, or test input changes.
- Keep examples runnable against loopback or a reachable public endpoint. Label reserved example domains/CIDRs as syntax placeholders.
- Link to the OpenAPI artifact rather than duplicating machine schemas.
- Run `pnpm format:check` and a link/path check after editing documentation.

## Pull-request checklist

- The implementation represents the current design only.
- Offline behavior has deterministic tests.
- Provider adapters and simulators remain contract-equivalent.
- Public schemas and the OpenAPI artifact agree.
- Secrets and sensitive target content remain redacted.
- Migration and rollback disposition is explicit.
- Consumer/operator/development docs are updated for behavior changes.
- All local gates pass before requesting review.
