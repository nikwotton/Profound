# Working Guidelines

- When the user corrects agent behavior in this project, add a concise, clear, generic preventive instruction to this file. Do not add ordinary new requirements sourced from the project specification or linked design documents.
- Document dependency installation and service startup as separate steps; never imply that installing dependencies starts the service unless an install script actually does so.
- Use reachable endpoints in runnable documentation examples. Reserve non-resolving example domains for clearly labeled syntax illustrations or isolated tests.
- Run the documented install command after dependency changes and resolve actionable package-manager warnings. Explicitly allow required build scripts and explicitly ignore understood optional ones.
- Treat GitHub CLI authentication failures inside a sandbox as potentially spurious. Verify with an independent Git or unsandboxed check before concluding that credentials are invalid or asking the user to reauthenticate.
- Do not identify unfamiliar UI controls from icon appearance alone. Verify their behavior or consult current official documentation, and state uncertainty when verification is unavailable.
- When a problem reproduces across unrelated projects or tasks, investigate app-, account-, or workspace-level causes before attributing it to repository state.
- When auditing a collaborative document, read its unresolved comments and replies as well as its body before requesting clarification or declaring the audit complete.
- Keep provider capabilities separate from routing preferences and intended use cases; do not encode a preferred use case as a technical incompatibility without evidence.
- During pre-v0 development, represent only the current design; do not preserve compatibility or migrations for earlier document or code revisions, and reset disposable data instead.
- When a task requires resolving discrepancies, implement and verify discovered discrepancies before reporting the audit complete.
- When a recurring audit changes repository files, finish that cycle by committing and pushing the changes, then verify CI passes on the pushed commit before reporting completion.
- Expose distinct developer workflows as explicit commands; keep environment-selected service dispatch internal to orchestrators and deployment runtimes.
- Keep caller-facing black-box E2E tests independent of deployment-stage and infrastructure metadata; test provider-specific infrastructure through a separate acceptance suite.
- Give top-level test commands safe defaults when possible; do not require undocumented environment setup for their basic supported path.
- Give each operator-supplied value one source of truth: deployed secrets come from the deployment secret store, non-secret knobs come from stage configuration, and runtime environment variables only transport those values.
- Keep pre-v0 operator configuration minimal: expose only values that must vary by installation, and keep tuning thresholds, feature policy, generated metadata, and safe defaults in typed code.
