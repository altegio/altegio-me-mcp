# Dependency upgrade — 2026-11-05

Versions were verified against the official npm registry, Node release index,
SDK documentation, Actions tags and container manifests on 2026-11-05.
The previous baseline is commit `3442a01` (package version 0.2.0).

| Component | Before | After | Reason |
| --- | --- | --- | --- |
| Node | 22.x | 26.13.0 LTS; also test 24.22.2 | Current active LTS with a maintained compatibility line |
| npm | Not pinned | 12.2.2 | Explicit engines and package-manager pin |
| TypeScript | 5.9.3 | 6.0.3 | Latest supported by typescript-eslint and ts-jest; 7.0.2 is intentionally held |
| MCP SDK | @modelcontextprotocol/sdk 1.31.0 | server/client 2.4.0; node 2.1.2 | Stable split SDK; retain legacy stateless 2025-11-25 transport |
| Playwright (optional browser check) | 1.63.0 | 1.64.1 | Current stable; verify actual types as well as CI stubs |
| Docker | Node 22 Alpine digest | Node 26.13.0 Alpine digest | Same non-root service, verified with read-only root filesystem |
| Cloud SDK | 587.0.0 | 592.0.0 full image digest | System Python was removed; use bundled Python; keep full image for curl |
| Cloud Build Docker builder | floating provider image | current provider digest (CLI 20.10.24) | Google-supported builder retained for managed-daemon compatibility; not a Docker Engine upgrade |
| checkout / setup-node | floating v7 | verified v7.0.1 / v7.1.0 commit SHAs | Immutable Action references |

## Direct packages (resolved lockfile versions)

| Package | Before | After | Use |
| --- | --- | --- | --- |
| `@modelcontextprotocol/node` | — | 2.1.2 | Runtime |
| `@modelcontextprotocol/server` | — | 2.4.0 | Runtime |
| `express` | 5.2.1 | 5.3.0 | Runtime |
| `pino` | 10.4.0 | 10.4.0 | Runtime |
| `zod` | 4.6.7 | 4.6.7 | Runtime |
| `@commitlint/cli` | 21.2.3 | 21.2.4 | Development |
| `@commitlint/config-conventional` | 21.2.3 | 21.2.4 | Development |
| `@eslint/js` | 10.0.1 | 10.0.1 | Development |
| `@modelcontextprotocol/client` | — | 2.4.0 | Development |
| `@types/express` | 5.0.6 | 5.0.6 | Development |
| `@types/jest` | 30.0.0 | 30.0.0 | Development |
| `@types/node` | 22.20.5 | 24.19.2 | Development |
| `ajv` | 8.20.0 | 8.20.0 | Development |
| `eslint` | 10.12.0 | 10.14.0 | Development |
| `husky` | 9.1.7 | 9.1.7 | Development |
| `jest` | 30.5.2 | 30.5.2 | Development |
| `lint-staged` | 17.6.0 | 17.6.0 | Development |
| `pino-pretty` | 13.1.3 | 13.2.0 | Development |
| `prettier` | 3.9.9 | 3.9.10 | Development |
| `ts-jest` | 29.4.14 | 29.4.15 | Development |
| `tsx` | 4.23.15 | 4.23.15 | Development |
| `typescript` | 5.9.3 | 6.0.3 | Development |
| `typescript-eslint` | 8.71.0 | 8.72.1 | Development |

`@types/node` stays on the latest Node 24 definitions so type checking cannot silently introduce APIs missing from the oldest supported runtime.

## Transitive dependencies

The lockfile was refreshed within supported direct constraints. Explicit overrides
move `glob` to 14.0.3 and `minimatch` to 11.0.4 because current Jest, ESLint and
coverage dependencies still select affected major lines. Their used glob/match
APIs remain available; lint, discovery, the complete suite and coverage exercise
these consumers on both supported Node lines. Remove the overrides when upstream
constraints adopt patched releases; do not apply `npm audit fix --force` blindly.

Production and optional-browser audits report zero advisories. The full development
audit still reports six low findings through Jest's `deepmerge@4.3.1` path, all
from [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
The registry offers no patched release. This is test configuration code, absent
from the production image, not remotely supplied configuration. The finding is
retained in audit output; CI fails on any moderate-or-higher development advisory
and on any production advisory. No suppression or unsupported Jest downgrade is used.

## References

- [Node 26.13.0 LTS release](https://nodejs.org/en/blog/release/v26.13.0)
- [TypeScript support in typescript-eslint](https://typescript-eslint.io/users/dependency-versions/)
- [SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [Supported Cloud Build images](https://docs.cloud.google.com/build/docs/cloud-builders)
- [Cloud SDK release notes](https://docs.cloud.google.com/sdk/docs/release-notes)
