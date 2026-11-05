# Open-source publication

The owner approved MIT licensing and public source distribution on **5 November
2026**. The existing repository is now public. Private vulnerability reporting,
secret scanning, push protection, Dependabot security updates and Pro-aligned
merge/Actions protections are enabled; see the verified
[repository settings](../.github/REPOSITORY_SETTINGS.md).

The npm package remains `private: true`, version 0.2.0. No npm or public container
release, credential rotation or history rewrite was performed. Future publishing
needs a separate decision on package naming, versioning and release ownership.

## Historical fixture provenance

The historical token-shaped value in the booking schema's documented-example test
matches the example in the anonymously accessible
[public booking OpenAPI document](https://developer.alteg.io/_bundle/en/public/openapi.json?download).
This match was verified on 5 November 2026; the corresponding specification source
predates this MCP fixture. Current tests use an explicitly synthetic value.
This establishes documentation provenance, not credential validity: the value was
never used for authentication or customer operations. No historical value is
repeated here and no Git history was rewritten.

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
keys and one token-shaped documented example. The documented example's provenance was subsequently confirmed as described above. No private
specification or diagnostic payload was added. Secret scanning remains a signal
for review, not proof that all future content is suitable for publication.

See [dependency notes](dependency-upgrade.md) for the version matrix and remaining
low development advisory. CI evidence and exact-head independent review belong to
the pull request. Production rollout requires the normal ordered release path,
merged/deployed revision verification, signed read-only probes and a bounded log
sample. Green local checks do not establish rollout or independent approval.
