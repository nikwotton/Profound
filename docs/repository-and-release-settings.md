# Repository and release settings

Workflow files cannot enforce every delivery control. Configure these GitHub and AWS settings before treating Profound Proxy Router v0 as a shipped service.

## Branch and merge policy

Protect `main` with:

- pull requests required for changes;
- the branch required to be up to date before merge;
- required `verify` and `production-shaped` checks;
- at least one approval;
- CODEOWNER review for owned paths;
- stale approvals dismissed when material commits are pushed;
- conversations resolved before merge;
- force pushes and branch deletion disabled;
- administrator bypass limited to documented emergencies.

Allow merge commits only. The release workflow reasons about cumulative main commits and immutable image promotion. Delete merged branches automatically. Enable the merge queue only when pull-request volume warrants it; required workflows already accept `merge_group` events.

## CODEOWNERS

Keep [`.github/CODEOWNERS`](../.github/CODEOWNERS) aligned with actual ownership. Changes to infrastructure, workflows, migrations, provider contracts, security/authentication, usage accounting, and redaction should require the appropriate platform or security owner rather than relying on a general approval.

AI review may remain advisory. Manual approval is authoritative for v0.

## Actions permissions

- Default `GITHUB_TOKEN` to read-only repository contents.
- Grant write permissions only in the specific job that requires them.
- Pin third-party actions to reviewed versions or immutable commit SHAs according to organization policy.
- Prevent pull requests from forks from accessing deployment environments or secrets.
- Retain build, OpenAPI, test, migration, and deployment artifacts for the organization's incident/debug window.

Dependabot configuration is committed in [`.github/dependabot.yml`](../.github/dependabot.yml). Review dependency changes through the same required checks; do not auto-merge infrastructure or runtime dependencies without ownership review.

## Environments

Create protected GitHub environments for at least `staging` and `production`.

Production should require:

- designated approvers;
- protected-branch deployment only;
- no self-review when organization policy supports it;
- an environment deployment concurrency rule;
- immutable image promotion from the previously validated stage.

Use disposable `ci-*` stages for pull-request deployments. The janitor workflow is a backstop, not a substitute for normal cleanup.

## AWS authentication

Use GitHub OIDC roles scoped to this repository, workflow/ref, account, region, and environment. Do not store AWS access keys in GitHub.

At minimum configure:

- `AWS_REGION`
- `AWS_DEPLOY_ROLE_ARN`
- `ECR_REPOSITORY`

The deploy role should have only the permissions required by SST, ECR promotion, migrations, deployed verification, and cleanup for its environment. Production and non-production should use distinct trust conditions and, where practical, distinct roles/accounts.

## Deployment variables

Configure the production environment with:

- `PROXY_DOMAIN`
- `PROXY_CERT_ARN`
- `CONTROL_DOMAIN`
- `CONTROL_CERT_ARN` when control DNS is externally managed
- `DATA_PLANE_ALLOWED_CIDRS`
- `CONTROL_PLANE_ALLOWED_CIDRS`

Configure equivalent `STAGING_*` values consumed by the release workflows. Point each private proxy DNS name at the emitted Network Load Balancer hostname. Validate certificate region, hostname coverage, and private DNS resolution before enabling clients.

Provider mode, scaling bounds, Axiom endpoint/dataset naming, retention, timeouts, thresholds, and optional feature policy are code-owned in v0 and are not repository or environment variables.

Runtime/vendor values belong in SST secrets, not GitHub variables or repository files. Required secret names and setup commands are documented in [OPERATIONS.md](OPERATIONS.md#required-stage-secrets).

## Labels and pull-request metadata

Create these migration labels:

- `migration:none`
- `migration:backward-compatible`
- `migration:forward-only`
- `migration:destructive`
- `migration:none-reviewed`

Also create `provider-freshness` for reviewed provider-source updates. Keep label spelling synchronized with the pull-request template and policy validator.

Every pull request must state:

- migration category and rollback disposition;
- whether provider contracts changed;
- whether OpenAPI changed;
- whether secrets, IAM, network boundaries, or retention changed;
- test evidence, including any intentionally skipped E2E, live-provider, or AWS acceptance checks.

## External integrations

Configure the GitHub App integration for the team messaging workspace to post new pull requests and review requests. Do not implement this through a repository webhook or long-lived user token.

Configure Axiom datasets, retention, and scoped tokens outside the repository as described in [OPERATIONS.md](OPERATIONS.md#telemetry-backend). Configure MaxMind credentials in the deployment environment. Keep vendor accounts and billing ownership documented in the platform secret/account inventory.

Generated client SDK compilation remains a roadmap item until consumer languages are selected. The committed OpenAPI artifact is the v0 client-generation source.

## Initial launch verification

Before the first production release, verify:

- branch protection and required checks behave on a test pull request;
- CODEOWNER changes cannot merge without owner review;
- OIDC can deploy without stored AWS keys and cannot assume the wrong environment role;
- staging deploy, migration, black-box E2E and AWS acceptance suites, rollback, and removal complete;
- production approval blocks an unapproved promotion;
- the promoted ECR digest matches the staging-validated digest;
- private DNS, certificates, CIDRs, and SST secrets are correct;
- production DynamoDB protection and point-in-time recovery are enabled;
- the release/drain coordinator observes and handles established tunnels;
- notification and telemetry integrations receive signed/redacted events;
- a disposable stale `ci-*` stage is removed by the janitor.

Record evidence in the release or change-management system rather than weakening a required check after a failure.
