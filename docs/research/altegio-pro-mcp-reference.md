# Altegio.Pro MCP as a reference

Research date: 2026-10-02. Source: https://github.com/altegio/altegio-pro-mcp (`main`).

## Stack

- TypeScript ESM, `@modelcontextprotocol/sdk ^1.30.0`, protocol `2025-11-25`, low-level `Server`
  with `setRequestHandler` (not `McpServer`). Its ADR keeps SDK 1.x until a platform canary on v2.
- Transports: stdio (`src/index.ts`) and Streamable HTTP on Express 5 (`src/http-server.ts`),
  stateful with `mcp-session-id`, one session registry per view. `/health` returns the version.
- zod 4 (`z.toJSONSchema`), pino to stderr, dotenv. Jest 30 + ts-jest.
- Node ≥20.17; Docker `node:22-alpine`, multi-stage, non-root, dumb-init.

## Auth

- The server is not an OAuth server; it trusts the `mcp.alteg.io` proxy, which forwards
  identity and token headers (`src/request-context.ts`) bound via AsyncLocalStorage.
- Upstream calls (`src/providers/altegio-client.ts`): `Authorization: Bearer <partner>, User <user>`,
  `Accept: application/vnd.api.v2+json`, base `ALTEGIO_API_BASE` (default
  `https://api.alteg.io/api/v1`).
- No multi-region support.

## Tool conventions

- `defineTool` (`src/tools/factory.ts`): strict zod input, JSON Schema `outputSchema`,
  annotations, handler returning a text summary plus `structuredContent`.
- Names `<domain>_<verb>[_object]`; glossary location / team_member / appointment / client.
- All four annotation hints on every tool, enforced by `tool-annotations.test.ts`.
- Write confirmation (`src/tools/confirmation.ts`): form elicitation when supported, otherwise a
  `confirmation_token` (HMAC over tool name and arguments, 10-minute TTL).
- Scopes checked at execution, not by filtering `tools/list`; refusals are in-band `isError`.
- Views: `/mcp`, `/mcp/readonly` (from `readOnlyHint`), facets; static lists per path;
  `docs/architecture/tool-surface.md` generated.
- Errors: `withErrorHandling` returns `isError` text naming the next action; upstream text
  sanitized and quoted.
- Pagination: `page` / `page_size` (25 default, 300 max) → `items` + `pagination{…}`
  (`src/tools/pagination.ts`).
- Untrusted text: `<<<UNTRUSTED …>>>` fences, stripping of turn-markup forgeries and invisible
  characters (`src/tools/tool-result.ts`); trust-boundary paragraph in server instructions.
- Resources `altegio://docs/*`, prompts for workflows.

## Catalog

`scripts/catalog/build.mjs` builds `src/generated/catalog.json` from the private
`biz.erp.api.docs` B2B specs. **No B2C booking endpoints** are in it; the ADR marks the `booking/…`
routes as B2C and out of scope (ADR D1).

## Quality, release, deploy

- CI `.github/workflows/ci.yml`: `lint` (eslint, prettier, tsc, catalog and surface checks),
  `test` (Node 20/22/24, coverage), `build`, `security` (`npm audit --audit-level=high`).
- husky, commitlint (conventional), lint-staged. Mocked tests by default; live suites opt-in.
- Semver `0.x.y-alpha.N`, `CHANGELOG.md`, annotated tags, GitHub prereleases; not on npm.
- Deploy: merges to `main` picked up by private automation behind the proxy.
- No directory publishing artefacts (`server.json`, registry entries, ChatGPT config).

## Reuse plan

- **Reuse almost as is:** tool factory, untrusted fencing, pagination, confirmation pattern,
  config schema, Dockerfile, CI workflow, annotation and surface tests, resource and prompt
  registries.
- **Pro-specific, leave out:** facets, onboarding wizard, analytics, password login, `mcp:pro:*`
  scopes, B2B client methods and catalog.
- **New for B2C:** booking client for `book_*` routes, catalog index, deep-link builder,
  stateless transport, locale and currency handling, Phase 2 OAuth server with phone sign-in.
