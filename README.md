# Altegio.me MCP Server

Status: the stateless MCP server foundation is built and tested, with the tool compliance suite,
the CI gate and the container image. No booking tools are registered yet, so `tools/list`
returns an empty list. The next work is the booking tools for a known business: business card,
services, team members, free slots, slot check and a pre-filled booking widget link. Decisions
and research are in [`docs/`](docs/).

A remote [MCP](https://modelcontextprotocol.io) server that lets clients of businesses using
Altegio (salons, barbershops, studios and similar) find a business, browse its services, team
members and free time slots, and book an appointment from AI assistants and their agents:
Claude, ChatGPT, Gemini, Copilot, Perplexity and others.

This is a separate product from [Altegio.Pro MCP](https://github.com/altegio/altegio-pro-mcp),
which serves business owners and staff. The Pro architecture reserves consumer (B2C) booking for
a separate server; this repository is that server.

## Product scope

**Phase 1: discover in chat, book in the widget.** No sign-in and no personal data in the chat.

- Search businesses that use Altegio and have online booking enabled.
- Show a business card, its bookable services, team members, dates and free time slots.
- Check that the chosen slot is still bookable, then return a link to the business's Altegio
  booking widget with service, team member and time already selected. The client confirms
  there, with the business's usual phone confirmation and prepayment rules.

**Phase 2: book in chat.** The client signs in with phone + SMS code on an Altegio.me page
(OAuth 2.1), then the assistant can create, reschedule and cancel appointments and list the
client's bookings. Interactive UI (MCP Apps) for hosts that render it.

**Distribution.** Claude Connectors Directory, then ChatGPT plugins, the MCP Registry, and
outreach to Perplexity, Mistral, xAI and Google. See
[`docs/research/ai-platforms-distribution.md`](docs/research/ai-platforms-distribution.md).

## Architecture

Request path of the server as built:

```
AI host (Claude, ChatGPT, ...)
        |  POST /mcp, JSON-RPC over Streamable HTTP, no session
        v
Express app (src/app.ts)
        |  call log -> Origin guard -> JSON body parser (100 kb limit)
        v
New SDK Server + Streamable HTTP transport for this one request (src/mcp)
        |
        v
Tool registry and factory (src/tools) -> scrubbed, fenced result or in-band error
```

`GET /health` answers `{"status":"ok","version":...}` for Cloud Run. `GET` and `DELETE` on `/mcp`
answer 405, because the server is stateless: it never sends an `mcp-session-id`, and every
`POST /mcp` is served by a fresh server and transport that are closed when the response ends.

| Module | Role |
|---|---|
| `src/config` | Environment validation with zod; fixed error text that never echoes a value |
| `src/mcp` | The only code that imports the MCP SDK: server creation, stateless request handler, server instructions |
| `src/tools` | Tool factory with zod schemas and annotations, registry, pagination shape, in-band errors, untrusted-text fencing |
| `src/observability` | pino logger, one structured call log line per `POST /mcp`, secret scrubbing |
| `src/compliance` | Directory-compliance rules R1-R13 and deliberately bad fixtures; test-only, not in the build |
| `src/util` | Package name and version read from `package.json` |

**SDK isolation rule.** Only `src/mcp` imports `@modelcontextprotocol/sdk`; ESLint rejects the
import anywhere else outside tests. Tools stay SDK-free, so a later move of the SDK touches
`src/mcp` only.

**Protocol support.** Protocol version 2025-11-25 is served with `@modelcontextprotocol/sdk`
1.x, the same as Altegio.Pro MCP. Requests for protocol version 2026-07-28 get HTTP 400 from
SDK 1.x. The move to SDK v2 is revisited together with the platform canary before launch and
touches `src/mcp` only.

Other notes:

- TypeScript, Express, zod, pino. Patterns reused from Altegio.Pro MCP: tool factory with zod
  schemas, annotations on every tool, untrusted-text fencing, pagination, actionable errors,
  CI layout.
- Target hosting: its own Cloud Run service in its own GCP project, on a domain that matches
  the brand (for example `mcp.altegio.me`, to be confirmed). It does not sit behind the
  `mcp.alteg.io` proxy, which only admits Altegio account holders.
- Later phases add the Altegio public booking API client
  (`api.alteg.io/api/v1`, partner token), a catalog index of bookable businesses refreshed by a
  scheduled job, and an OAuth 2.1 authorization server with phone + SMS sign-in.
- Decisions and their reasons: [`docs/decisions/0001-scope-and-architecture.md`](docs/decisions/0001-scope-and-architecture.md).
- What other teams must answer before or during the build: [`docs/open-questions.md`](docs/open-questions.md).

## Research

| Topic | File |
|---|---|
| Altegio public booking API, discovery, deep links, limits | [`docs/research/altegio-booking-api.md`](docs/research/altegio-booking-api.md) |
| Distribution on AI platforms and their requirements | [`docs/research/ai-platforms-distribution.md`](docs/research/ai-platforms-distribution.md) |
| How Altegio.Pro MCP is built, what to reuse | [`docs/research/altegio-pro-mcp-reference.md`](docs/research/altegio-pro-mcp-reference.md) |
| The `mcp.alteg.io` platform and why we don't use it | [`docs/research/mcp-platform-reference.md`](docs/research/mcp-platform-reference.md) |

## Environment variables

The server validates these at startup and exits with a list of the offending names (never their
values) when one is missing or invalid.

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `PORT` | HTTP port (Cloud Run sets it) | `8080` | no |
| `ALTEGIO_API_BASE` | Base URL of the Altegio public API; must be https when NODE_ENV is production | `https://api.alteg.io/api/v1` | no |
| `ALTEGIO_API_TOKEN` | Partner API token of developer account 2630 "Altegio AI" (shared with Altegio.Pro MCP) | none | yes, non-empty |
| `PUBLIC_BASE_URL` | Public URL of the server; its origin is the allowed browser `Origin` | none | yes, http(s) URL |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` | `info` | no |
| `NODE_ENV` | `development`, `test` or `production`; `.env.example` sets `development` for local runs and the Docker image sets `production` | `production` | no |

`ALTEGIO_API_TOKEN` has the same name and the same rule (any non-empty string) as in Altegio.Pro
MCP. [`.env.example`](.env.example) carries the placeholder `your_partner_token_here`, so a copied
`.env` starts the server. A real token is needed once the server calls the Altegio API; a wrong
one then shows up as HTTP 401 from that API. A token shorter than 8 characters cannot be redacted
from output, so the server then logs one `config_warning` line at startup that names the setting,
never its value. Real secrets live in GCP Secret Manager, never in git.

When `NODE_ENV` is not set the server runs as `production`: loopback browser origins are refused
and an `http://` `ALTEGIO_API_BASE` stops startup, so the partner token never travels in cleartext.

## Local run

Requires Node 22 (the version is pinned in `.nvmrc`; with nvm run `nvm use`).

```bash
cp .env.example .env
npm ci
npm run dev
```

In another terminal:

```bash
curl -s localhost:8080/health
npx -y @modelcontextprotocol/inspector@2.9.0 --cli http://localhost:8080/mcp --transport http --method tools/list
```

`GET /health` returns the status and version. `tools/list` returns an empty list until the
booking tools land. Raw HTTP clients must send `Accept: application/json, text/event-stream` on
`POST /mcp`, as the Streamable HTTP transport requires.

## Checks

```bash
npm run check
```

runs lint, format check, typecheck, the Jest tests and the build, in that order. It is the same
set the CI job runs. Tests use Jest with ts-jest, as in Altegio.Pro MCP, and live in
`__tests__/` directories next to the code. Run them with `npm test` or `npx jest <path>`.

The compliance suite (`src/compliance`) runs every registered tool through rules R1-R13 and fails
the build when a tool:

- lacks a title or any of the three behaviour hints;
- mixes reads and writes;
- has a name longer than 64 characters or outside the naming pattern;
- has a description that addresses the model with instructions;
- asks for personal data in its inputs;
- uses a write or sign-in upstream route (the registry is read-only in this phase).

## Docker

```bash
docker build -t altegio-me-mcp .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e ALTEGIO_API_TOKEN=your_partner_token_here \
  -e PUBLIC_BASE_URL=http://localhost:8080 \
  altegio-me-mcp
```

The image is `node:22-alpine`, built in two stages, installs production dependencies only and
runs as the non-root `node` user. `scripts/smoke.sh IMAGE` starts the image with a canary token,
checks `/health`, the stateless `/mcp` endpoint, the logs (no token, no tool arguments), the
container user and a clean SIGTERM stop. It runs locally (Docker through Colima on macOS) and in
CI.

## CI and branch rules

Workflow `CI` (`.github/workflows/ci.yml`) runs on pull requests to `main` and on pushes to
`main`. It has a single job named `test` on Node 22, with these steps in order: checkout,
install, conventional commits (pull requests only), lint, format check, typecheck, unit tests,
build, Docker build, container smoke test, dependency audit (`npm audit --audit-level=high`).

Ruleset `default-branch-ci-gate` protects `main`: changes only through pull requests, required
status check `test`, no force-push, no deletion. Organization admins keep a bypass for
emergencies; nobody else has one. The ruleset body is in
[`.github/rulesets/main-ci-gate.json`](.github/rulesets/main-ci-gate.json).

Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`,
`ci:`, `build:`). A husky `commit-msg` hook checks them locally and CI checks every commit and
the pull request title.

## Deploy

Deploys go only through git: a Cloud Build trigger on merge to `main` deploys to the service's
own Cloud Run project and domain. No manual `gcloud run deploy`. The trigger, the service and
the domain are not set up yet; until then the server runs locally and in CI only.

## Cost estimate

Rough, refined per phase. Assumptions: Cloud Run in `europe-west1`, 1 vCPU / 512 MiB, one minimum instance (OAuth
endpoints must answer within 10 s for Claude, and cold starts hurt chat latency). The server
calls no LLM: the model runs on the AI host's side.

| Item | Expected (≈100k tool calls / month) | Peak (≈1M tool calls / month) |
|---|---|---|
| Cloud Run service | $10–15 | $30–50 |
| Catalog refresh job, Scheduler, storage | $1–5 | $1–5 |
| Secret Manager, logging, egress | $1–3 | $3–10 |
| **Phase 1 total** | **≈ $10–25** | **≈ $35–65** |
| Phase 2: OAuth state store (Firestore) | $1–5 | $5–15 |
| Phase 2: SMS sign-in codes, $0.02–0.10 each | ≈ $20–100 per 1,000 sign-ins | scales with sign-ins |
| Optional: nightly evals via Anthropic API | $10–30 | $10–30 |

Who pays for SMS (Altegio or the business) is an open question; see
[`docs/open-questions.md`](docs/open-questions.md).

## Repository conventions

- Conventional commits, enforced locally and in CI (see CI and branch rules).
- Direct pushes to `main` are rejected; every change goes through a pull request with a green
  `test` check.
- GSD working files stay out of git unless the team agrees otherwise (the directory is listed
  in `.gitignore`).

## Owner

Mike Kondakov ([@kondamih](https://github.com/kondamih)). Questions: Slack `#dev-ai-coding`.
