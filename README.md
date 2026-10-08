# Altegio.me MCP Server

Status: the stateless MCP server serves six read-only booking tools for a known business:
business card (`business_get`), services (`business_list_services`), team members
(`business_list_team_members`), dates with free time (`business_list_dates`), free time slots
(`business_list_time_slots`) and a slot check that hands off a pre-selected booking widget link
(`book_check`). They call the Altegio public booking API through a throttled client
(`src/booking`), and a live suite has checked that client against a real business. The hosting
setup (a Cloud Run pipeline behind the platform proxy, edge limits, secrets as files, alerts) is
in the repository and live since 2026-10-05 at `https://mcp.alteg.io/me`, see [Deploy](#deploy).
Callers authenticate with their own Altegio partner token, which the server checks with Altegio
and uses for their upstream calls; actions for one signed-in client come with OAuth in Phase 2
([ADR 0004](docs/decisions/0004-caller-authorization-tiers.md), see [Access](#access)).
The catalog of bookable
businesses and search come next. Decisions and research are in [`docs/`](docs/).

A remote [MCP](https://modelcontextprotocol.io) server that lets clients of businesses using
Altegio (salons, barbershops, studios and similar) find a business, browse its services, team
members and free time slots, and book an appointment from AI assistants and their agents:
Claude, ChatGPT, Gemini, Copilot, Perplexity and others.

This is a separate product from [Altegio.Pro MCP](https://github.com/altegio/altegio-pro-mcp),
which serves business owners and staff. The Pro architecture reserves consumer (B2C) booking for
a separate server; this repository is that server.

## Product scope

**Phase 1: discover in chat, book in the widget.** No end-user sign-in and no personal data in
the chat. The caller (a partner's agent or app) presents its Altegio partner token.

- Search businesses that use Altegio and have online booking enabled.
- Show a business card, its bookable services, team members, dates and free time slots.
- Check that the chosen slot is still bookable, then return a link to the business's Altegio
  booking widget with service, team member and time already selected. The client confirms
  there, with the business's usual phone confirmation and prepayment rules.

**Phase 2: book in chat.** The client signs in with phone + SMS code on an Altegio.me page
(OAuth 2.1), then the assistant can create, reschedule and cancel appointments and list the
client's bookings. Interactive UI (MCP Apps) for hosts that render it. Interactive hosts
(claude.ai, ChatGPT, connector directories) connect from this phase on, through the same OAuth.

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
        |  call log -> Origin guard -> proxy signature -> edge limits
        |  -> caller's partner token (checked with Altegio, cached) -> JSON body parser (100 kb)
        v
New SDK Server + Streamable HTTP transport for this one request (src/mcp)
        |
        v
Tool registry and factory (src/tools) -> scope check -> scrubbed, fenced result or in-band error
        |
        v
Booking client (src/booking) -> request gate -> Altegio public booking API (api.alteg.io/api/v1),
                                                signed with the caller's partner token
```

`GET /health` answers `{"status":"ok","version":...,"commit":...}` for Cloud Run (`commit` is the
`COMMIT_SHA` of the build, or `null`), and stays open. With `PROXY_AUTH=required` (the default),
`POST /mcp` is served only with a valid `x-mcp-proxy-auth` signature from the platform proxy; any
other request gets HTTP 401 `proxy_auth_required` before its body is read. With `CALLER_AUTH=required`
(the default) a request also needs a valid Altegio partner token, see [Access](#access). `GET` and `DELETE` on `/mcp`
answer 405, because the server is stateless: it never sends an `mcp-session-id`, and every
`POST /mcp` is served by a fresh server and transport that are closed when the response ends.

| Module | Role |
|---|---|
| `src/config` | Environment validation with zod; fixed error text that never echoes a value |
| `src/mcp` | The only code that imports the MCP SDK: server creation, stateless request handler, server instructions |
| `src/tools` | Tool factory with zod schemas and annotations, registry, the six booking tools, pagination shape, in-band errors, untrusted-text fencing |
| `src/booking` | Typed client for the six documented booking routes (company card, services, team members, dates, time slots, slot check), the request gate that throttles calls on the partner budget, and the deep-link builder for the booking widget |
| `src/security` | Proxy signature check, client address and edge limits, the caller's partner token check (`caller-auth.ts`, `partner-token.ts`) |
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
  route on the platform's `mcp.alteg.io` proxy, next to `https://mcp.alteg.io/pro` (ADR 0002). The `/me` lane
  went live anonymous on 2026-10-05 and moves to partner-token admission (ADR 0004, open item I7).
- The booking client calls the Altegio public API (`api.alteg.io/api/v1`) with the partner
  token and never creates, holds or changes a booking: `book_check` is a validation-only call,
  and a live run confirmed that it leaves the slot free. Later phases add a catalog index of
  bookable businesses refreshed by a scheduled job, and phone + SMS sign-in over OAuth 2.1,
  designed together with the platform proxy, which is the authorization server on
  `mcp.alteg.io` (ADR 0002).
- Decisions and their reasons: [`docs/decisions/0001-scope-and-architecture.md`](docs/decisions/0001-scope-and-architecture.md),
  [`docs/decisions/0002-public-address-on-platform-proxy.md`](docs/decisions/0002-public-address-on-platform-proxy.md),
  [`docs/decisions/0003-host-in-platform-project.md`](docs/decisions/0003-host-in-platform-project.md),
  [`docs/decisions/0004-caller-authorization-tiers.md`](docs/decisions/0004-caller-authorization-tiers.md).
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
| `ALTEGIO_API_TOKEN` | Partner API token of developer account 2630 "Altegio AI" (in production the Secret Manager secret `MARKETPLACE_PARTNER_TOKEN`). Local runs use this plain form | none | this or `ALTEGIO_API_TOKEN_FILE`, non-empty |
| `ALTEGIO_API_TOKEN_FILE` | Absolute path of a mounted file that holds the partner token; wins over `ALTEGIO_API_TOKEN` and is re-read lazily every 60 s, so a rotation of the shared secret needs no restart. An upstream 401 or 403 forces one re-read (at most once per 60 s) and one retry. An unreadable or empty file stops startup | none | this or `ALTEGIO_API_TOKEN` |
| `PUBLIC_BASE_URL` | Public URL of the server; its origin is the allowed browser `Origin` | none | yes, http(s) URL |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` | `info` | no |
| `NODE_ENV` | `development`, `test` or `production`; `.env.example` sets `development` for local runs and the Docker image sets `production` | `production` | no |
| `PROXY_AUTH` | `required` or `off`. With `required`, `POST /mcp` is served only with a valid `x-mcp-proxy-auth` signature from the platform proxy and the server does not start without a proxy key. `.env.example` sets `off` for local runs | `required` | no |
| `MCP_PROXY_BACKEND_KEY` | Shared key of the proxy signature, a comma-separated list during a rotation, each key at least 32 characters. Production uses the file form below | none | with `PROXY_AUTH=required`, this or `MCP_PROXY_BACKEND_KEY_FILE` |
| `MCP_PROXY_BACKEND_KEY_FILE` | Absolute path of a mounted file that holds the proxy key; wins over `MCP_PROXY_BACKEND_KEY` and is re-read lazily every 60 s, so a rotation needs no restart | none | with `PROXY_AUTH=required`, this or `MCP_PROXY_BACKEND_KEY` |
| `CALLER_AUTH` | `required` or `optional`. With `required`, every `POST /mcp` needs the caller's own Altegio partner token: behind the proxy (`PROXY_AUTH=required`) only in the proxy's signed `x-mcp-auth-altegio-partner-token` header, without it as `Authorization: Bearer <token>` or `X-Altegio-Partner-Token`. The token is checked with Altegio (cached by hash: valid 5 min, invalid 30 s) and signs that caller's upstream calls. `optional` serves a caller without a token with `ALTEGIO_API_TOKEN`, logs one `config_warning` at startup, and exists for the proxy rollout and local runs; a token that is sent is still checked. `.env.example` sets `optional` | `required` | no |
| `CLIENT_USER_TOKEN_HEADER` | Name of the signed header that carries the client's Altegio user token behind the proxy. It must start with `x-mcp-auth-` (the proxy signature covers only those headers) and is lower-cased. Change it only if the platform's I8 header names differ. `.env.example` leaves it empty | `x-mcp-auth-altegio-user-token` | no |
| `CLIENT_SCOPE_HEADER` | Name of the signed header that carries the client's space-separated scope list; same rules as `CLIENT_USER_TOKEN_HEADER`. Only `mcp:me:read` in it is honoured, and `mcp:me:book` is granted to nobody. `.env.example` leaves it empty | `x-mcp-auth-scope` | no |
| `CLIENT_CALLER_KIND` | Value of `x-mcp-auth-kind` that marks a client sign-in; it must not be `partner`. `.env.example` leaves it empty | `client` | no |
| `COMMIT_SHA` | Commit of the deployed build, 7 to 40 lowercase hex characters; reported as `commit` by `GET /health` | none (`commit` is `null`) | no |
| `TRUSTED_PROXY_HOPS` | Proxies between the caller and the server, counted from the right of `X-Forwarded-For`. It picks the client address when the proxy does not sign `x-mcp-auth-client-ip`, and with `PROXY_AUTH=off`. `0` means no proxy. The leftmost entries and the TCP peer are never used | `1` | no |
| `SHARED_EGRESS_CIDRS` | Comma-separated IPv4 or IPv6 CIDRs whose addresses share one request budget and are not limited per address, because many users sit behind them. The default is Anthropic's outbound range used by claude.ai | `160.79.104.0/21` | no |
| `EXTRA_ALLOWED_ORIGINS` | Comma-separated http(s) origins served next to the `PUBLIC_BASE_URL` origin. Requests without an `Origin` header are always served; a refused origin's host is logged as `origin_host` | `https://claude.ai,https://claude.com` | no |
| `EDGE_MAX_INFLIGHT` | Most `POST /mcp` requests in flight at once; more get HTTP 429. Kept below the Cloud Run concurrency of 80 so our own 429 comes before Google's | `60` | no |
| `EDGE_MAX_INFLIGHT_PER_IP` | Most requests in flight at once from one address (an IPv6 caller counts as its /64) | `6` | no |
| `EDGE_IP_BURST` | Token-bucket size for one address: requests it may send at once | `40` | no |
| `EDGE_IP_REFILL_PER_SEC` | Token-bucket refill for one address, in requests per second | `3` | no |
| `EDGE_POOL_BURST` | Token-bucket size for the shared-egress pool. Above the request gate's capacity on purpose: under saturation the gate's in-band "busy, retry in N s" answer is friendlier to the model than an HTTP 429 | `200` | no |
| `EDGE_POOL_REFILL_PER_SEC` | Token-bucket refill for the shared-egress pool, in requests per second | `20` | no |
| `GATE_MAX_QUEUE_PER_KEY` | Most upstream calls one non-pool client may have waiting in the request gate; the shared pool is not capped per client | `8` | no |

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

## Access

Every call needs an Altegio partner token: the token of a developer account in the Altegio
marketplace (register at https://app.alteg.io/appstore/developers/1; the token is under account
settings). Send it on every `POST` to `https://mcp.alteg.io/me`:

```bash
curl -s https://mcp.alteg.io/me \
  -H 'Authorization: Bearer <partner token>' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`X-Altegio-Partner-Token: <partner token>` works too. Agent frameworks pass it as the server's
bearer token or header, for example `authorization_token` of an MCP server in the Claude API.
The server checks the token with Altegio and makes the caller's upstream calls with it, so
Altegio's per-partner limits and licence terms apply to the caller. Without a token the answer is
HTTP 401; with a token Altegio refuses, 401 `invalid_token`; when Altegio cannot be reached for
the check, 503 with `Retry-After`.

Access is tiered by scope ([ADR 0004](docs/decisions/0004-caller-authorization-tiers.md), amended
by ADR 0005, own places first). Three scopes:

- `mcp:me:discover` is the base tier. Every admitted caller holds it (a partner token, a client
  sign-in, or no token while `CALLER_AUTH=optional`), and the six known-business tools need only it.
- `mcp:me:read` is the signed-in client's own places and bookings. Only a client sign-in grants it,
  and `me_list_places` and `me_list_bookings` require it. An anonymous or partner caller who calls
  one of them gets an in-band error that names the client sign-in.
- `mcp:me:book` is declared for later writes and granted to nobody yet, whatever a scope header says.

`tools/list` shows the same tools to everyone. A client sign-in reaches the server as a signed
`x-mcp-auth-kind: client` with the client's Altegio user token and scope list in signed
`x-mcp-auth-*` headers (names set by `CLIENT_USER_TOKEN_HEADER`, `CLIENT_SCOPE_HEADER` and
`CLIENT_CALLER_KIND`). Without the proxy, with `CALLER_AUTH=optional`, a local run sends the user
token directly as `X-Altegio-User-Token`; with `CALLER_AUTH=required` a direct user token is
refused. The user token is sent to Altegio only on the signed-in routes, next to the partner token,
and never appears in a result or a log. Interactive hosts such as claude.ai and ChatGPT cannot
send a partner token and connect through the platform's sign-in once it ships.

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
token they return an in-band error. `.env.example` sets `CALLER_AUTH=optional`, so these calls
need no caller token; with `CALLER_AUTH=required` send `Authorization: Bearer <partner token>`. Raw HTTP clients must send `Accept: application/json, text/event-stream` on
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
the partner budget is shared with marketplace confirmations (developer 2630). `ALTEGIO_E2E_RECORD=1 npm run test:live`
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

Status: live. The service is published at `https://mcp.alteg.io/me` through the platform proxy's
anonymous lane (altegio-mcp-platform #250, deployed 2026-10-05) and reaches Cloud Run over https on
its `run.app` address, which answers `/health` and refuses an unsigned `/mcp` with 401. Every
revision comes from the trigger on `main`; the serving commit is reported by `/health`. What ran
live, with dates and revisions, is in the deployment record in
[`docs/runbooks/gcp-hosting.md`](docs/runbooks/gcp-hosting.md); the operational contract is
[`docs/runbooks/operations.md`](docs/runbooks/operations.md).

Deploys go only through git: a merge to `main` starts the Cloud Build trigger
`altegio-me-mcp-deploy` in the platform's GCP project `altegio-mcp` (ADR 0003), which deploys the
Cloud Run service `altegio-me-mcp` in `europe-west1`. The values below are the ones in
`cloudbuild.yaml` (the trigger name is the one `scripts/gcp/bootstrap.sh` creates), and a test
fails when this table and the pipeline differ.

### Deployed settings

| Setting | Value | Note |
|---|---|---|
| Region | `europe-west1` | Belgium |
| Service | `altegio-me-mcp` | its own Cloud Run service, not a container on a platform VM |
| Minimum instances | `0` | revision minimum; service minimum is 1 for serving capacity |
| Maximum instances | `1` | revision and service maximum; rollout budgeting is described in the operational contract |
| CPU | `1` | vCPU, with startup boost; billed per request (CPU throttling on) |
| Memory | `512Mi` | |
| Concurrency | `80` | requests per instance; our own cap of 60 in flight answers 429 before Google does |
| Request timeout | `60` | seconds |
| Ingress | `all` | the `run.app` address cannot be closed to the proxy, see below |
| Runtime account | `altegio-me-mcp-runtime@altegio-mcp.iam.gserviceaccount.com` | reads only the two secrets |
| Trigger | `altegio-me-mcp-deploy` | region `europe-west1`, runs `/cloudbuild.yaml` on a merge to `main` |

**How a deploy goes.** Increment `release.json.sequence`, merge the checked PR,
then Cloud Build verifies the production image with a signed HTTPS protocol
fixture, pushes only the commit tag and serializes candidate deployment,
liveness/unsigned-rejection checks and explicit traffic promotion using Cloud Run
etag. Older release numbers cannot overwrite newer releases. Cleanup removes only
the owning candidate tag; failed production health restores prior traffic.
Rollback is a forward revert PR with a higher sequence. See
[the operational contract](docs/runbooks/operations.md) for monitoring/publication
gates, process allocation, limitations and interrupted-build recovery.

The placeholder service created by `scripts/gcp/bootstrap.sh` is the only deploy outside the Cloud Build trigger.

**Public address and access.** Clients reach the service at `https://mcp.alteg.io/me`, a route on
the platform proxy (ADR 0002) that forwards to `/mcp`. `GET /health` is readable only on the
service's own `run.app` address; through the proxy only `/mcp` is reachable. Every `POST /mcp`
needs a valid proxy signature (`x-mcp-proxy-auth`) and gets HTTP 401 without it, before the body
is read. The `run.app` address stays open to the internet, because Cloud Run's internal ingress
admits only callers inside the project's network and the proxy comes in over public egress, so
the signature is the access control there. The edge limits in the table above (in flight, per
address, shared pool) apply per client address as the proxy signs it.

**Caller access.** The deployed revision runs with `CALLER_AUTH=required` (since 2026-10-06): the
proxy's `/me` lane refuses a call without a partner token, and this server refuses a signed call
that does not carry one, so the account-2630 token no longer serves anonymous callers (rollout in
[ADR 0004](docs/decisions/0004-caller-authorization-tiers.md)). The platform monitor's canary sends
the account-2630 partner token.

**Secrets.** No secret is in the image, in git or in an environment variable. The partner token
(the platform's secret `MARKETPLACE_PARTNER_TOKEN`, which holds the account-2630 token; Altegio.Pro
MCP runs under a different token) and the proxy key issued for this route
(`MCP_PROXY_BACKEND_KEY_ME`) are mounted as Secret Manager volumes, the `latest` version of each.
The server re-reads them within 60 seconds, so a rotation needs no restart, and an Altegio 401 or
403 forces one re-read (at most once per 60 seconds).

**Service accounts.** Two accounts of our own. The runtime account above reads only the two
secrets. The build account `altegio-me-mcp-build` deploys only this service and pushes to the
repository `cloud-run`. Neither the trigger nor the service ever runs as the project's default
Compute Engine account, because the platform has granted that account access to its secrets.

**Logs and who reads them.** One structured line per `POST /mcp` goes to Cloud Logging, bucket
`_Default` of `altegio-mcp`: tool name, outcome, timings and counters, no tool arguments, no token
and no client address. Retention is a project-wide setting owned by the platform: 30 days is the
Google default for that bucket, and it is not confirmed for this project until the platform
answers (I6). Staff can read the project's logs through the platform's logs MCP, and the proxy
writes its own request line for `/me` (route, tool, method) to the platform's BigQuery dataset
`mcp_requests`, which keeps 90-day partitions. Our logs hold no personal data.

**Labels.** `app=altegio-me-mcp` is set only on the Cloud Run service, the uptime checks and the
alert policies; accounts, the trigger, the secrets and the log-based metrics cannot carry it, so
cost by label covers Cloud Run only and everything else is found by name (runbook, "Resources").

**Timeouts.** One tool call is cut at 25 seconds by the server, below the 60 seconds of Cloud
Run, below the 120 seconds the proxy waits for response headers, below the 240 seconds Claude
allows for a tool call (per the connector documentation at
[claude.com/docs/connectors/building](https://claude.com/docs/connectors/building)).

**MCP SDK.** `@modelcontextprotocol/sdk` stays on 1.x, as in Altegio.Pro MCP.

## Cost estimate

Monthly cost of the hosting in the platform's project `altegio-mcp`, in US dollars. Assumptions:
Cloud Run in `europe-west1` (price tier 1) with 1 vCPU and 512 MiB, billed per request, one
minimum instance kept warm; about 3.5 `POST /mcp` requests per tool call at about 0.5 seconds
each; the instance is busy for 175,000 seconds a month at the expected load and for about half of
the month at the peak; about 10 KB of answer per tool call; 20 deploys a month. The server calls
no LLM: the model runs on the AI host's side. The platform proxy in front of the service
(`mcp.alteg.io`, ADR 0002) is the platform's cost and is not counted here. Free allotments are not
subtracted, except for the uptime checks (see below).

| Item | Expected (≈100k tool calls / month) | Peak (≈1M tool calls / month) |
|---|---|---|
| Cloud Run: one idle minimum instance, 2,592,000 s at $0.00000375 per second | $9.72 | $9.72 |
| Cloud Run: busy time above the idle rate ($0.0000215 per second) and requests ($0.40 per million) | $3.90 | $29.26 |
| Uptime checks: two, every 5 minutes, three regions, 51,840 executions at $0.30 per 1,000 | $3.30 | $3.30 |
| Secret Manager: at most 86,400 secret reads at $0.03 per 10,000 | $0.30 | $0.30 |
| Cloud Logging: 50 GiB a month free, then $0.50 per GiB | $0 | $1 |
| Network egress: first GiB free, then $0.12 per GiB | $0 | $1 |
| Cloud Build: about 6 minutes a deploy at $0.003 per minute, normally inside 2,500 free minutes | $0.40 | $0.40 |
| Artifact Registry: about 4 GiB of images kept, $0.10 per GiB-month after 0.5 GiB | $0.40 | $0.40 |
| **Hosting total** | **≈ $18** | **≈ $45** |
| Product, later: OAuth state store (Firestore), unless the platform proxy holds it (ADR 0002) | $1–5 | $5–15 |
| Product, later: SMS sign-in codes, $0.02–0.10 each | ≈ $20–100 per 1,000 sign-ins | scales with sign-ins |
| Product, later: catalog refresh job, Scheduler, storage | $1–5 | $1–5 |
| Product, later: nightly evals via Anthropic API (optional) | $10–30 | $10–30 |

Uptime checks cost about $3 a month at 5 minutes because the platform's own checks leave about
41,000 of the 1,000,000 free monthly executions; at 1 minute they would cost about $140, which is
why the period is 5 minutes. Without any free allotment the two checks would cost about $16. Alert
policies are not charged before September 2027 at the earliest.

Prices read on 2026-10-05 from https://cloud.google.com/run/pricing,
https://cloud.google.com/monitoring/pricing, https://cloud.google.com/logging/pricing,
https://cloud.google.com/secret-manager/pricing, https://cloud.google.com/build/pricing,
https://cloud.google.com/artifact-registry/pricing and
https://cloud.google.com/vpc/network-pricing. They are list prices and change; the figures are not
re-read automatically.

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
