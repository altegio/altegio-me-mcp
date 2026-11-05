# Security

Security fixes target the current main branch and maintained deployment. Node 24
and 26 are the supported runtime lines; use at least the versions in package.json.

## Reporting

Do not include vulnerabilities, tokens, user data or production responses in
public issues. Current repository collaborators should contact the repository
owner, [Mike Kondakov (@kondamih)](https://github.com/kondamih), through their
existing private Altegio channel. Include the affected commit, a synthetic
reproduction, impact and a proposed mitigation where possible.

A public private-reporting channel must be enabled and verified by the owner
before the repository becomes public. This document does not claim that GitHub
private vulnerability reporting is already available. See the
[publication decisions](docs/open-source-readiness.md).

## Boundaries and checks

Production requires a trusted proxy signature before caller identity is used.
Scopes gate tools, user routes use the caller's user token, and writes require
confirmation tied to that caller. Host and Origin checks precede upstream work.
Local auth-off settings in `.env.example` are for development.

CI audits all dependencies and fails on moderate or higher findings, with a
stricter zero-advisory production audit. Known development-only upstream residuals
are documented in [dependency notes](docs/dependency-upgrade.md); they are not
silenced with audit exclusions. Fixed localhost TLS keys under `scripts/fixtures`
are test fixtures and must never be used for real services.
