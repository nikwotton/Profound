# Working Guidelines

- When the user corrects agent behavior in this project, add a concise, clear, generic preventive instruction to this file. Do not add ordinary new requirements sourced from the project specification or linked design documents.
- Document dependency installation and service startup as separate steps; never imply that installing dependencies starts the service unless an install script actually does so.
- Use reachable endpoints in runnable documentation examples. Reserve non-resolving example domains for clearly labeled syntax illustrations or isolated tests.
- Run the documented install command after dependency changes and resolve actionable package-manager warnings. Explicitly allow required build scripts and explicitly ignore understood optional ones.
- Treat GitHub CLI authentication failures inside a sandbox as potentially spurious. Verify with an independent Git or unsandboxed check before concluding that credentials are invalid or asking the user to reauthenticate.
- Do not identify unfamiliar UI controls from icon appearance alone. Verify their behavior or consult current official documentation, and state uncertainty when verification is unavailable.
- When a problem reproduces across unrelated projects or tasks, investigate app-, account-, or workspace-level causes before attributing it to repository state.
