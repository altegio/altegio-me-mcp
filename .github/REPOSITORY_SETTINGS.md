# Repository settings

The owner authorized public source distribution and alignment with Altegio Pro MCP
on **5 November 2026**. The settings below were applied through the GitHub API and
read back. Collaborator roles and secrets were preserved.

## Merge policy

The active [`default-branch-ci-gate` ruleset](https://github.com/altegio/altegio-me-mcp/rules/24413832)
protects the default `main` branch. It requires a pull request, resolved review
conversations and an up-to-date branch with successful `test`, `analyze` checks.
Every required check is bound to GitHub Actions (integration ID **15368**).
Force pushes and branch deletion are blocked, with no bypass actors.
The checked-in JSON in [rulesets](rulesets/) records the applied policy.

Only merge commits are allowed; merged branches are deleted automatically.
Independent review of the exact head remains a delivery requirement. As in Pro,
GitHub requires **zero approval events**: code-owner and latest-push approvals
are not mandatory. [CODEOWNERS](CODEOWNERS) routes optional review to verified
administrators. Changing these gates or a required check name needs coordinated
workflow and settings changes. Pro's private catalog App is not installed here;
these checks do not claim to validate private specification drift.

## Security and Actions

Dependency alerts, Dependabot security updates, secret scanning, push protection
and private vulnerability reporting are enabled. Actions must use full commit
SHAs. Workflow tokens are read-only by default and Actions cannot approve pull
requests; jobs request additional permissions explicitly when needed.
The existing Actions allowlist is unchanged. CodeQL uses the public-repository
workflow; no paid private security product was enabled.

Use the private reporting route in [SECURITY.md](../SECURITY.md). A green scanner
run does not establish that a change is safe; findings still require triage.

## Public distribution

The repository is public and MIT licensed. Its description, README homepage and
Altegio/MCP/TypeScript topics are configured. Source builds and existing hosted
services remain the supported delivery paths. The package keeps `private: true`;
no npm package, container registry release or additional infrastructure was
published by this settings change.
