# Repository and release settings

GitHub repository settings are part of the delivery contract and cannot be inferred from workflow files alone.

- Protect `main`; require it to be up to date, require the `verify` and `production-shaped` checks, require one approval and CODEOWNER review, and allow merge commits only.
- Delete merged branches automatically. Enable the merge queue only when PR volume warrants it; the required workflows already accept `merge_group` events.
- Configure the GitHub App integration for the team messaging workspace to post new pull requests and review requests. Do not implement this through a repository webhook or long-lived token.
- Configure AWS environments with OIDC roles scoped to the repository and environment. Do not store AWS access keys in GitHub.
- Configure the production environment variables `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `PROXY_DOMAIN`, `PROXY_CERT_ARN`, `CONTROL_DOMAIN`, `CONTROL_CERT_ARN` when applicable, `DATA_PLANE_ALLOWED_CIDRS`, and `CONTROL_PLANE_ALLOWED_CIDRS`, plus the equivalent `STAGING_*` endpoint variables. Point each private proxy DNS name at its emitted Network Load Balancer hostname.
- Add the four `migration:*` labels and `migration:none-reviewed`, plus `provider-freshness`.
- Keep AI review advisory if enabled; manual approval remains authoritative for v0.
- Generated client SDK compilation remains a roadmap item until consumer languages are selected.
