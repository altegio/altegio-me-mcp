# Security

Security fixes target the current main branch and maintained deployment. Node 24
and 26 are the supported runtime lines; use at least the versions in package.json.

## Reporting

Use **Report a vulnerability** on the repository's
[Security page](https://github.com/altegio/altegio-me-mcp/security/advisories).
Private vulnerability reporting was enabled and verified on 5 November 2026.
Include the affected revision, impact and a minimal synthetic reproduction.
Do not include live tokens or customer data.

If private reporting is unavailable, open a minimal
[contact-request issue](https://github.com/altegio/altegio-me-mcp/issues/new)
asking verified maintainers `@kondamih` or `@petroff` for a private channel.
Include no exploit details, credentials, client records or private URLs in that
public request. Share details only once a private channel is agreed.

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
