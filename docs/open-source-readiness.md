# Open-source readiness

This is preparation, not authorization to publish. The repository and npm package
remain private, version 0.2.0. The owner approved [MIT](../LICENSE), copyright
(c) 2026 Altegio, on 2026-11-05. No npm release, public
container release, access change or history rewrite is part of this change.

## Owner decisions before publication

| Decision | Concrete proposal | Current state |
| --- | --- | --- |
| License and rights holder | MIT, copyright (c) 2026 Altegio | Approved and applied; root LICENSE and both package manifests agree |
| Security and conduct reports | Enable and test GitHub private vulnerability reporting; provide a confirmed private fallback contact in SECURITY.md and CODE_OF_CONDUCT.md | Existing collaborators can contact the documented owner; public route not verified |
| Visibility | Make this existing repository public only after reporting route and history review are approved | Private retained |
| Historical content | Review the pre-existing token-shaped example in the booking schema tests; current code uses an explicit synthetic value | No evidence that it is active; provenance must be confirmed, no credential probe or history rewrite performed |
| Branch protection | Keep PRs and the current `test` status required; agree whether independent review should be enforced by a GitHub rule | Existing settings retained; this delivery requires independent exact-head review |
| Code scanning | Use the prepared SHA-pinned CodeQL workflow once public; consider Dependabot/security features with the owner | No paid private feature enabled; CodeQL skips private repositories |
| Package distribution | Keep this an HTTP service built from source/container; approve package naming, version and release ownership before any npm publication | Private flag retained; installed tarball tested locally |

## Prepared repository surface

README onboarding, configuration and authorization model; generated inventory of
12 tools and 4 prompts; CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG;
issue and PR templates; Dependabot updates; compatible runtime/toolchain pins;
CI for lint, formatting, source/test types, actual optional-browser types, both
supported runtimes, inventory drift, tarball install, release tests, signed
container behavior and dependency audits.

The npm tarball is allowlisted to the compiled service, package metadata, README,
MIT LICENSE and the minimal install helper. Tests, fixtures,
research, private evidence and environment files are excluded. It exposes an HTTP
executable, not a JavaScript library or stdio server.

## Evidence and limits

The initial baseline passed 52 suites and 2,184 tests, with seven live suites
skipped. Synthetic regressions cover Host rejection before authentication,
concurrent token-probe admission and cancellation on HTTP disconnect. Existing
booking tests cover per-client ownership and confirmation behavior.

Gitleaks 8.30.1 scanned the candidate tree and 277 reachable historical commits
before this change. Findings were fixed localhost TLS fixtures, explicit test
keys and one token-shaped documented example. The last item's provenance remains
unconfirmed. No private specification or diagnostic payload was added. A secret
scanner is not proof that all historical information is suitable for publication;
the owner still needs to review historical disclosure and the public reporting route.

See [dependency notes](dependency-upgrade.md) for the version matrix and remaining
low development advisory. CI evidence and exact-head independent review belong to
the pull request. Production rollout requires the normal ordered release path,
merged/deployed revision verification, signed read-only probes and a bounded log
sample. Green local checks do not establish rollout or independent approval.
