# Altegio.me MCP Server

Status: the stateless MCP server serves six read-only booking tools for a known business:
business card (`business_get`), services (`business_list_services`), team members
(`business_list_team_members`), dates with free time (`business_list_dates`), free time slots
(`business_list_time_slots`) and a slot check that hands off a pre-selected booking widget link
(`book_check`). They call the Altegio public booking API through a throttled client
(`src/booking`), and a live suite has checked that client against a real business. Hosting, the
catalog of bookable businesses and search come next. Decisions and research are in
[`docs/`](docs/).

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
        |
        v
Booking client (src/booking) -> request gate -> Altegio public booking API (api.alteg.io/api/v1)
```

`GET /health` answers `{"status":"ok","version":...,"commit":...}` for Cloud Run (`commit` is the
`COMMIT_SHA` of the build, or `null`), and stays open. With `PROXY_AUTH=required` (the default),
`POST /mcp` is served only with a valid `x-mcp-proxy-auth` signature from the platform proxy; any
other request gets HTTP 401 `proxy_auth_required` before its body is read. `GET` and `DELETE` on `/mcp`
answer 405, because the server is stateless: it never sends an `mcp-session-id`, and every
`POST /mcp` is served by a fresh server and transport that are closed when the response ends.

| Module | Role |
|---|---|
| `src/config` | Environment validation with zod; fixed error text that never echoes a value |
| `src/mcp` | The only code that imports the MCP SDK: server creation, stateless request handler, server instructions |
| `src/tools` | Tool factory with zod schemas and annotations, registry, the six booking tools, pagination shape, in-band errors, untrusted-text fencing |
| `src/booking` | Typed client for the six documented booking routes (company card, services, team members, dates, time slots, slot check), the request gate that throttles calls on the partner budget, and the deep-link builder for the booking widget |
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
- Target hosting: its own Cloud Run service in the platform's GCP project `altegio-mcp`,
  where every Altegio MCP server lives (ADR 0003), published at `https://mcp.alteg.io/me` as a
  route on the platform's `mcp.alteg.io` proxy, next to `https://mcp.alteg.io/pro` (ADR 0002). The proxy admits only Altegio account holders today;
  the anonymous `/me` route is requested from the platform team.
- The booking client calls the Altegio public API (`api.alteg.io/api/v1`) with the partner
  token and never creates, holds or changes a booking: `book_check` is a validation-only call,
  and a live run confirmed that it leaves the slot free. Later phases add a catalog index of
  bookable businesses refreshed by a scheduled job, and phone + SMS sign-in over OAuth 2.1,
  designed together with the platform proxy, which is the authorization server on
  `mcp.alteg.io` (ADR 0002).
- Decisions and their reasons: [`docs/decisions/0001-scope-and-architecture.md`](docs/decisions/0001-scope-and-architecture.md),
  [`docs/decisions/0002-public-address-on-platform-proxy.md`](docs/decisions/0002-public-address-on-platform-proxy.md).
- What other teams must answer before or during the build: [`docs/open-questions.md`](docs/open-questions.md).

## Research

| Topic | File |
|---|---|
| Altegio public booking API, discovery, deep links, limits | [`docs/research/altegio-booking-api.md`](docs/research/altegio-booking-api.md) |
| Distribution on AI platforms and their requirements | [`docs/research/ai-platforms-distribution.md`](docs/research/ai-platforms-distribution.md) |
| How Altegio.Pro MCP is built, what to reuse | [`docs/research/altegio-pro-mcp-reference.md`](docs/research/altegio-pro-mcp-reference.md) |
| The `mcp.alteg.io` platform, whose proxy publishes this server at `/me` | [`docs/research/mcp-platform-reference.md`](docs/research/mcp-platform-reference.md) |

## Environment variables

The server validates these at startup and exits with a list of the offending names (never their
values) when one is missing or invalid.

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `PORT` | HTTP port (Cloud Run sets it) | `8080` | no |
| `ALTEGIO_API_BASE` | Base URL of the Altegio public API; must be https when NODE_ENV is production | `https://api.alteg.io/api/v1` | no |
| `ALTEGIO_API_TOKEN` | Partner API token of developer account 2630 "Altegio AI" (shared with Altegio.Pro MCP). Local runs use this plain form | none | this or `ALTEGIO_API_TOKEN_FILE`, non-empty |
| `ALTEGIO_API_TOKEN_FILE` | Absolute path of a mounted file that holds the partner token; wins over `ALTEGIO_API_TOKEN` and is re-read lazily every 60 s, so a rotation of the shared secret needs no restart. An upstream 401 or 403 forces one re-read (at most once per 60 s) and one retry. An unreadable or empty file stops startup | none | this or `ALTEGIO_API_TOKEN` |
| `PUBLIC_BASE_URL` | Public URL of the server; its origin is the allowed browser `Origin` | none | yes, http(s) URL |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` | `info` | no |
| `NODE_ENV` | `development`, `test` or `production`; `.env.example` sets `development` for local runs and the Docker image sets `production` | `production` | no |
| `PROXY_AUTH` | `required` or `off`. With `required`, `POST /mcp` is served only with a valid `x-mcp-proxy-auth` signature from the platform proxy and the server does not start without a proxy key. `.env.example` sets `off` for local runs | `required` | no |
| `MCP_PROXY_BACKEND_KEY` | Shared key of the proxy signature, a comma-separated list during a rotation, each key at least 32 characters. Production uses the file form below | none | with `PROXY_AUTH=required`, this or `MCP_PROXY_BACKEND_KEY_FILE` |
| `MCP_PROXY_BACKEND_KEY_FILE` | Absolute path of a mounted file that holds the proxy key; wins over `MCP_PROXY_BACKEND_KEY` and is re-read lazily every 60 s, so a rotation needs no restart | none | with `PROXY_AUTH=required`, this or `MCP_PROXY_BACKEND_KEY` |
| `COMMIT_SHA` | Commit of the deployed build, 7 to 40 lowercase hex characters; reported as `commit` by `GET /health` | none (`commit` is `null`) | no |

`ALTEGIO_API_TOKEN` has the same name and the same rule (any non-empty string) as in Altegio.Pro
MCP. [`.env.example`](.env.example) carries the placeholder `your_partner_token_here`, so a copied
`.env` starts the server. Tool calls need the real partner token of developer account 2630; a
wrong one shows up as HTTP 401 from the Altegio API. A token shorter than 8 characters cannot be redacted
from output, so the server then logs one `config_warning` line at startup that names the setting,
never its value. In production the token is mounted as a file (`ALTEGIO_API_TOKEN_FILE`) and the
current and the previous token are both redacted from tool results and error text, so a token that
was rotated out and is quoted in an upstream message does not reach a client. Real secrets live in
GCP Secret Manager, never in git.

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

`GET /health` returns the status, version and commit. `tools/list` lists the six booking tools. Tool
calls reach the Altegio API, so they need the real partner token in `.env`; with the placeholder
token they return an in-band error. Raw HTTP clients must send `Accept: application/json, text/event-stream` on
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

The live suite checks the booking client against the real Altegio API. It is opt-in and never
part of CI:

```bash
npm run test:live
```

It needs the real `ALTEGIO_API_TOKEN` and `ALTEGIO_E2E_LOCATION_ID` (the location id of a real
business, for example the demo location `722227`, whose booking routes answer although its
widget reports `active: 0`) in `.env`. It parses
every route with the same schemas as the fixture tests, checks that two identical slot checks
are both accepted and leave the slot free, and makes at most 20 upstream calls per run, because
the partner budget is shared with Altegio.Pro MCP. `ALTEGIO_E2E_RECORD=1 npm run test:live`
also refreshes the sanitised recordings in `src/booking/__tests__/fixtures/live/`. The sanitiser
removes exactly this: the token, e-mail addresses, phone numbers, team-member and contact names,
addresses, coordinates, business titles and account ids (plus free text, links and image URLs);
the required test run fails on any real value for those keys and parses the recordings with the
route schemas. Without `ALTEGIO_E2E=1`, which only `test:live` sets, every live test is skipped.

The real-browser check of the widget link lives in `scripts/browser-check`, an isolated package
with its own pinned Playwright. It runs only locally and is never part of CI or the Docker image:

```bash
npm --prefix scripts/browser-check ci --ignore-scripts
npm --prefix scripts/browser-check start
```

It needs the same two variables as the live suite and an installed Google Chrome. Its results
are recorded in `docs/research/widget-deep-link.md` ("Browser check results").

## Docker

```bash
docker build -t altegio-me-mcp .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e ALTEGIO_API_TOKEN=your_partner_token_here \
  -e PUBLIC_BASE_URL=http://localhost:8080 \
  -e PROXY_AUTH=off \
  altegio-me-mcp
```

The image is `node:22-alpine`, built in two stages, installs production dependencies only and
runs as the non-root `node` user. `scripts/smoke.sh IMAGE` starts the image with a canary token
and a proxy key file copied into the container, signs its requests the way the platform proxy does,
and checks `/health`, the signed `/mcp` path, the refusal of an unsigned request, the logs (no token,
no tool arguments), the container user and a clean SIGTERM stop. It runs locally (Docker through Colima on macOS) and in
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

Deploys go only through git: a Cloud Build trigger on merge to `main` deploys the Cloud Run
service `altegio-me-mcp` in the platform's GCP project `altegio-mcp`, region `europe-west1`
(ADR 0003). No manual `gcloud run deploy`. The service reads the partner token from the
project's existing Secret Manager secret `ALTEGIO_API_TOKEN`, the one Altegio.Pro MCP uses.
Clients reach the service at `https://mcp.alteg.io/me`, a route on the platform proxy that
forwards to the service's `/mcp` (ADR 0002). The trigger, the service and the route are not set
up yet; until then the server runs locally and in CI only.

## Cost estimate

Rough, refined per phase. Assumptions: Cloud Run in `europe-west1`, 1 vCPU / 512 MiB, one minimum instance (cold
starts hurt chat latency). The server calls no LLM: the model runs on the AI host's side. The
service runs in the platform's project `altegio-mcp` (ADR 0003), and every resource carries the
label `app=altegio-me-mcp`, so this cost shows up there as a separate line. The platform proxy in
front of the service (`mcp.alteg.io`, ADR 0002) is the platform's cost and is not counted here.

| Item | Expected (≈100k tool calls / month) | Peak (≈1M tool calls / month) |
|---|---|---|
| Cloud Run service | $10–15 | $30–50 |
| Catalog refresh job, Scheduler, storage | $1–5 | $1–5 |
| Secret Manager, logging, egress | $1–3 | $3–10 |
| **Phase 1 total** | **≈ $10–25** | **≈ $35–65** |
| Phase 2: OAuth state store (Firestore), unless the platform proxy holds it (ADR 0002) | $1–5 | $5–15 |
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
