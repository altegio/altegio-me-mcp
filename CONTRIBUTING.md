# Contributing

Altegio.me MCP serves end users. Preserve the boundary between a partner browsing
businesses and a signed-in client managing their own bookings. Maintainer:
[Mike Kondakov (@kondamih)](https://github.com/kondamih).

## Development

Use Node 26.13.0 and npm 12.2.2; Node 24.22.2 is also tested.

```sh
npm ci
npm ci --prefix scripts/browser-check --ignore-scripts
npm run check
npm run typecheck:browser
npm run inventory:check
npm run test:package
python3 -m unittest discover -s scripts/tests -v
```

`npm test` uses synthetic credentials and fixtures. No real account is needed.
Copy `.env.example` to `.env` only for local interactive use. Never commit tokens,
raw API responses, private specifications or customer information. Live suites
are explicit opt-ins and can create, move or cancel appointments; they are not
part of ordinary contribution verification or CI.

## Changes and review

Open an issue describing the behavior and a synthetic reproduction. Use a focused
branch and Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`). Include the
problem, resulting behavior, compatibility risks and checks in the pull request.
An independent review of the exact head is required before merge, alongside the
required `test` and `analyze` checks. New commits require re-review of the changed diff.

Keep SDK imports in `src/mcp`; use `src/tools` for tools and `src/booking` for
upstream calls. Preserve per-request identity, scopes, ownership checks and
confirmation tokens. Do not automatically retry ambiguous writes. Add behavioral
regressions for changed auth, transport, booking and cancellation behavior; avoid
tests that merely repeat literals or implementation details.

When the registry changes, run `npm run inventory:generate`. Keep documentation,
protocol smoke checks and the platform monitor's tool catalog consistent.

## Delivery

Increment `release.json.sequence` for runtime or operational changes. Recheck it
against current main before merging. A main merge triggers the existing ordered
Cloud Build release; do not deploy manually. See [operations](docs/runbooks/operations.md)
for candidate verification, promotion, rollback and release-lock recovery.

The service executable is HTTP-only. `npm run test:package` packs and installs it
in a temporary project and tests protocol, scope refusal and shutdown with fake
credentials. There is no supported JavaScript library export or published npm
release. Publishing, repository visibility, access and license changes require
separate owner approval.
