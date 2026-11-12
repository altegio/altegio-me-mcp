# Altegio.me MCP Server

[![CI](https://github.com/altegio/altegio-me-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/altegio/altegio-me-mcp/actions/workflows/ci.yml)

An HTTP [Model Context Protocol](https://modelcontextprotocol.io) server for people
booking appointments with businesses that use Altegio. It discovers a business,
shows services and available times, and reads or changes the signed-in client's
own bookings. This is the consumer service; [Altegio Pro MCP](https://github.com/altegio/altegio-pro-mcp)
serves business owners and staff.

The server exposes **12 tools and 4 prompts**, listed in the generated
[tool inventory](docs/tool-inventory.md). Booking, rescheduling and cancellation
require a preview, a confirmation token and the client's agreement. Unsupported
booking conditions return a pre-filled booking-widget link.

- [Run locally](#local-run) · [Configuration](#environment-variables) · [Access](#access)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)
- [Operations](docs/runbooks/operations.md) · [Hosting](docs/runbooks/gcp-hosting.md)

Transport: stateless Streamable HTTP at `POST /mcp`, protocol **2025-11-25**.
No stdio mode, persistent sessions, resource API or background scheduler is provided.
The maintained hosted route is `https://mcp.alteg.io/me`; the platform owns the proxy,
OAuth/sign-in and monitoring. Direct production requests require the proxy signature
and an authorized partner or client identity. The backend does not issue user tokens.

Licensed under [MIT](LICENSE), copyright (c) 2026 Altegio.
The source repository is public. The npm package remains unpublished and
`private: true`; see [publication status](docs/open-source-readiness.md).

## Product scope

**Known business and widget handoff.** The caller (a partner's agent or app)
presents its Altegio partner token. The tools show a business card, its bookable services, team
members, dates and free time slots, check that the chosen slot is still bookable, and return a
link to the business's Altegio booking widget with service, team member and time already selected.
The client confirms there, with the business's usual phone confirmation and prepayment rules. The widget handles phone confirmation and prepayment. Signed-in tools below may accept
booking-form fields required by the business.

**The client's own places** ([ADR 0005](docs/decisions/0005-own-places-first.md),
[ADR 0006](docs/decisions/0006-in-chat-booking-at-own-places.md)). A signed-in client sees the
places they already go to and their bookings, and books in the chat there or at any other
business they know by id, and moves and cancels their own appointments, with `me_book`,
`me_reschedule_booking` and `me_cancel_booking`, each in two steps: a preview with a confirmation
token, then the write. The client's name and phone come from their Altegio profile and never from
the chat; the e-mail does too, except at a business whose booking form requires an e-mail the
profile lacks — there `me_book` takes it as the optional `email` argument
([ADR 0007](docs/decisions/0007-email-in-chat-when-required.md)), sends it only to that business
with that booking, and never returns or keeps it. The widget link stays for partner and anonymous callers, services with online
prepayment, memberships and inactive widgets (ADR 0006 D3 as amended 2026-10-12). Sign-in (phone + SMS and OAuth) is owned by the platform proxy. Local development
can instead use the direct user-token header. On top of
these tools run the cases the Altegio.me app lacks, built and described under
[Cases](#cases): two people side by side, freed-slot monitoring and slot hold with a reminder. A
searchable catalog of all businesses is parked; a business the client names is found by
`business_search` (name, city and country), which reads the city's business list from
`GET /companies` as it is (ADR 0005 D2, amended 2026-10-12) and matches the name on the server:
at most three pages of 1000 per city, reused for ten minutes per process, and the largest city
of the network holds under 2000 active businesses. These listing calls are the ones Altegio logs
as "suspicious search params" (open question B1).

**Distribution.** Claude Connectors Directory listing and promo inside the Altegio.me app; later
ChatGPT, the MCP Registry, and outreach to Perplexity, Mistral, xAI and Google. See
[`docs/research/ai-platforms-distribution.md`](docs/research/ai-platforms-distribution.md).

## Cases

Cases the Altegio.me app lacks run on the tools above, with no tool of their own. Each case has a
server prompt that a client can offer its user, an example dialogue and an eval task; the prompts
are listed over `prompts/list`, and the decisions behind each case are in
[`docs/research/cases.md`](docs/research/cases.md).

### Two people side by side

A signed-in client books two appointments at one of their places, at the same start, with two
different named team members, for example a parent and a child. It is one `me_book` call with an
optional `second_appointment` (its own services and a team member): one preview that lists both
appointments, one confirmation token over both, and one create with two appointments, so either
both exist or neither does. The prompt is `book_side_by_side`.

What it does not do:

- Both bookings are under the client's name. Nothing about the second person (name, phone,
  e-mail, a comment) is taken or sent; the client tells the business who the second one is for.
- One place, one start time and exactly two appointments. Both team members must be named and
  different; "any team member" is refused for a pair, because the booking service could pick the
  same team member twice.
- Online prepayment, a membership-only service, an inactive widget and a place without an
  earlier visit end at the business's booking widget, which books one appointment at a time, so
  the answer carries one pre-filled link for each appointment.
- If the booking service names only one of the two bookings, the answer says
  `partially_booked` with the booked id and what to do next.
- Each booking is moved or cancelled on its own with `me_reschedule_booking` or
  `me_cancel_booking`.

> **Client:** Book me and my son at BaBarber on Saturday, me with Anna, him with Oleg, same time.
>
> **Assistant:** (`me_list_places`, `business_list_time_slots` for each) Anna and Oleg are both
> free at 11:00 and 14:30 on Sat 17 Oct. 11:00?
>
> **Client:** 11:00.
>
> **Assistant:** (`me_book` preview) BaBarber, Sat 17 Oct 11:00 (+07:00). First appointment:
> men's haircut with Anna, 600. Second appointment: kids' haircut with Oleg, 400. Both bookings
> are under your name; nothing about the second person is sent. Online cancellation is allowed
> until 2 hours before the start. Book both?
>
> **Client:** Yes.
>
> **Assistant:** (`me_book` with the confirmation token) Booked: two appointments, booking 6762101
> and booking 6762102. Both are under your name.

The eval task for this case is [`evals/tasks/me-two-people-side-by-side.yaml`](evals/tasks/me-two-people-side-by-side.yaml).

### Freed-slot monitoring

A scheduled task of the client's AI host checks the free times of a favourite team member and
reports them. Nothing is stored on this server, a run books nothing, and the booking happens in the
chat with `me_book` once the client picks a time. There is no tool, scheduler or notification
channel for it: each run reads with `business_list_dates` and then `business_list_time_slots` for
every date found, which the host sends like any other read.

Hosts: Claude scheduled tasks (Cowork) and Claude Code routines, at most once an hour. Other hosts
are not verified, and the text makes no claim about them. The prompt is `watch_for_a_free_slot`.

Setup, in three lines:

1. In the chat, `me_list_places` gives the usual place, service and team member; the client gives
   the dates (within 62 days) and the times of day.
2. The assistant helps create one scheduled task on the host, daily unless the client asks for more
   often, with only the ids, the dates and the times of day in its text.
3. Each run reports the free times inside the window or that there are none yet; the client stops
   the watch by pausing or deleting the task.

> **Client:** My usual barber is full this week. Tell me when an evening time frees up before 25
> Oct.
>
> **Assistant:** (`me_list_places`) You usually see Anna at BaBarber for a men's haircut. I will set
> up a daily scheduled task that checks Anna's free times after 17:00 up to 25 Oct and tells you
> what it finds. A run only reads and books nothing. Set it up?
>
> **Client:** Yes.
>
> **Assistant:** Done: a daily task with the place, service and Anna's ids and that window. Nothing
> about you is in it.
>
> *(Next morning, the task's report)* Anna is free on Thu 15 Oct at 18:00 and 19:30. Nothing else
> before 25 Oct.
>
> **Client:** Book the 18:00.
>
> **Assistant:** (`me_book` preview) BaBarber, Thu 15 Oct 18:00 (+07:00), men's haircut with Anna,
> 600. Online cancellation is allowed until 2 hours before the start. Book it?
>
> **Client:** Yes.
>
> **Assistant:** (`me_book` with the confirmation token) Booked: booking 6762201.

What it does not do:

- A run never books, moves or cancels. Where a connection has no client sign-in, `me_book` answers
  with the sign-in refusal and `book_check` gives the pre-filled booking link.
- The slot may be gone by the time the client reads the report; the `me_book` preview checks again.
- The one host run of 2026-10-09 (Claude Desktop) could not reach the server, because a claude.ai
  or Claude Desktop connector cannot send the partner token that `/me` needs until the client
  sign-in of the platform proxy exists. The record and the retest condition are in
  [`docs/research/cases.md`](docs/research/cases.md) under "Host runs".

The eval task for this case is [`evals/tasks/me-watch-for-a-free-slot.yaml`](evals/tasks/me-watch-for-a-free-slot.yaml).

### Slot hold

A client keeps a time at one of their places while they decide: the assistant books it with
`me_book` after the client says yes, then helps set up a one-time scheduled task on the client's
AI host for one day before the business's latest online cancellation time. That time is in the
`me_book` preview as `cancel_until` (the start minus the business's limit, in the business's own
offset). The task only reminds the client of the booking and asks whether to keep it or cancel it.
The prompt is `hold_a_slot`.

What it does not do:

- The reminder changes nothing on its own. A scheduled run is never the client's consent: if the
  client answers cancel, the assistant shows the cancellation with `me_cancel_booking` and cancels
  only after the client says yes in the chat.
- No hold where the business does not allow online cancellation or does not state its limit
  (`cancel_until` is null), and no reminder task when that time has passed; a time less than a day
  away gets a reminder a few hours before it.
- One hold per place at a time, and a service with online prepayment is not held; it ends at the
  business's booking widget.
- The server keeps nothing for it: no scheduler, no stored hold and no tool of its own.
- A booking that cancels itself with no reminder waits for the proxy's client sign-in (I8) and one
  host run that shows an unattended cancel with a preview and a confirmation; it is not built,
  see "Slot hold" in [`docs/research/cases.md`](docs/research/cases.md).

> **Client:** Hold Saturday 17 Oct at 18:00 with Anna at BaBarber for me. I will know by
> Thursday.
>
> **Assistant:** (`me_list_places`, `business_list_time_slots`, `me_book` preview) BaBarber, Sat
> 17 Oct 18:00 (+07:00), men's haircut with Anna, 600. Online cancellation is allowed until 2
> hours before the start. Latest online cancellation: 2026-10-17 16:00 (UTC+07:00). Book it?
>
> **Client:** Yes.
>
> **Assistant:** (`me_book` with the confirmation token) Booked: booking 6762301. Shall I set up a
> one-time scheduled task for Fri 16 Oct, one day before 16:00 on Saturday, that reminds you of
> it and asks whether you keep it or cancel it? It changes nothing on its own.
>
> **Client:** Yes.
>
> *(Fri 16 Oct, the task's reminder)* You have a booking at BaBarber on Sat 17 Oct at 18:00 with
> Anna. Keep it or cancel it?
>
> **Client:** Cancel it.
>
> **Assistant:** (`me_cancel_booking` preview) Cancel booking 6762301, BaBarber, Sat 17 Oct 18:00?
>
> **Client:** Yes.
>
> **Assistant:** (`me_cancel_booking` with the confirmation token) Cancelled.

The eval task for this case is [`evals/tasks/me-hold-a-slot.yaml`](evals/tasks/me-hold-a-slot.yaml).

## Prompts

The server lists four prompts over `prompts/list`, each one user message in the client's voice that
names the tools to use and asks for nothing about the sign-in:

- `book_my_usual`: shows the places the client already goes to, proposes the usual service and team
  member, and books it in the chat once the client agrees.
- `book_side_by_side`: books two appointments at the same start with two different team members,
  both under the client's name.
- `watch_for_a_free_slot`: helps set up a scheduled task that checks a team member's free times and
  reports them; a run only reads.
- `hold_a_slot`: books a time and sets up a one-time reminder before the cancellation limit that
  asks keep or cancel; the reminder changes nothing on its own.

## Architecture

Request path of the server as built:

```
AI host (Claude, ChatGPT, ...)
        |  POST /mcp, JSON-RPC over Streamable HTTP, no session
        v
Express app (src/app.ts)
        |  call log -> Host/Origin guards -> proxy signature -> edge limits
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
| `src/compliance` | Directory-compliance rules R1-R14 and deliberately bad fixtures; test-only, not in the build |
| `src/util` | Package name and version read from `package.json` |

**SDK isolation rule.** Only `src/mcp` imports `@modelcontextprotocol/server` and `@modelcontextprotocol/node`; ESLint rejects the
import anywhere else outside tests. Tools stay SDK-free, so a later move of the SDK touches
`src/mcp` only.

**Protocol support.** SDK v2 (`@modelcontextprotocol/server` and the Node transport)
serves the existing 2025-11-25 protocol through its legacy transport. This SDK upgrade
does not enable protocol 2026-07-28. A separate platform/client canary and delivery
review are required before changing the protocol mode.

Other notes:

- TypeScript, Express, zod, pino. Patterns reused from Altegio.Pro MCP: tool factory with zod
  schemas, annotations on every tool, untrusted-text fencing, pagination, actionable errors,
  CI layout.
- Target hosting: its own Cloud Run service in the platform's GCP project `altegio-mcp`,
  where every Altegio MCP server lives (ADR 0003), published at `https://mcp.alteg.io/me` as a
  route on the platform's `mcp.alteg.io` proxy, next to `https://mcp.alteg.io/pro` (ADR 0002). The `/me` lane
  went live anonymous on 2026-10-05 and moves to partner-token admission (ADR 0004, open item I7).
- The booking client calls the Altegio public API (`api.alteg.io/api/v1`) with the partner
  token. Only the three write tools create, move or cancel a booking, and only with the signed-in
  client's user token after a confirmed preview; `book_check` is a validation-only call, and a
  live run confirmed that it leaves the slot free. Later phases add a catalog index of
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
| `ALTEGIO_APP_BASE` | Base URL of the Altegio app host, where the Integrations Hub partner routes live (the installation status the assistant-booking gate reads); must be https when NODE_ENV is production | `https://app.alteg.io` | no |
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
| `CLIENT_SCOPE_HEADER` | Name of the signed header that carries the client's space-separated scope list; same rules as `CLIENT_USER_TOKEN_HEADER`. `mcp:me:read` and `mcp:me:book` in it are honoured (a client holds both only when the list names both). `.env.example` leaves it empty | `x-mcp-auth-scope` | no |
| `CLIENT_CALLER_KIND` | Value of `x-mcp-auth-kind` that marks a client sign-in; it must not be `partner`. `.env.example` leaves it empty | `client` | no |
| `CONFIRMATION_SECRET` | Key of the confirmation tokens of the write tools, 32 to 512 printable characters without spaces. Unset, each process uses its own random key, so a confirmation is valid only on the instance that issued it; set it to share confirmations across instances. A token works once per instance. `.env.example` leaves it empty | none | no |
| `COMMIT_SHA` | Commit of the deployed build, 7 to 40 lowercase hex characters; reported as `commit` by `GET /health` | none (`commit` is `null`) | no |
| `TRUSTED_PROXY_HOPS` | Proxies between the caller and the server, counted from the right of `X-Forwarded-For`. It picks the client address when the proxy does not sign `x-mcp-auth-client-ip`, and with `PROXY_AUTH=off`. `0` means no proxy. The leftmost entries and the TCP peer are never used | `1` | no |
| `SHARED_EGRESS_CIDRS` | Comma-separated IPv4 or IPv6 CIDRs whose addresses share one request budget and are not limited per address, because many users sit behind them. The default is Anthropic's outbound range used by claude.ai | `160.79.104.0/21` | no |
| `EXTRA_ALLOWED_ORIGINS` | Comma-separated http(s) origins served next to the `PUBLIC_BASE_URL` origin. Requests without an `Origin` header are always served; a refused origin's host is logged as `origin_host` | `https://claude.ai,https://claude.com` | no |
| `EXTRA_ALLOWED_HOSTS` | Additional ingress hostnames, space-separated with no ports or wildcards. The public hostname and loopback are allowed; tagged candidates of explicitly listed Cloud Run service hosts are also allowed. | empty | no |
| `EDGE_MAX_INFLIGHT` | Most `POST /mcp` requests in flight at once; more get HTTP 429. Kept below the Cloud Run concurrency of 80 so our own 429 comes before Google's | `60` | no |
| `EDGE_MAX_INFLIGHT_PER_IP` | Most requests in flight at once from one address (an IPv6 caller counts as its /64) | `6` | no |
| `EDGE_IP_BURST` | Token-bucket size for one address: requests it may send at once | `40` | no |
| `EDGE_IP_REFILL_PER_SEC` | Token-bucket refill for one address, in requests per second | `3` | no |
| `EDGE_POOL_BURST` | Token-bucket size for the shared-egress pool. Above the request gate's capacity on purpose: under saturation the gate's in-band "busy, retry in N s" answer is friendlier to the model than an HTTP 429 | `200` | no |
| `EDGE_POOL_REFILL_PER_SEC` | Token-bucket refill for the shared-egress pool, in requests per second | `20` | no |
| `GATE_MAX_QUEUE_PER_KEY` | Most upstream calls one non-pool client may have waiting in the request gate; the shared pool is not capped per client | `8` | no |
| `MARKETPLACE_APPLICATION_ID` | Id of this server's Integrations Hub application (2642 in production). Set, a client books and moves from the chat only at businesses where it is active; unset, at every business with online booking. Keep it unset until Altegio has switched the application on for the Altegio.me locations | none | no |

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
- `mcp:me:book` is the signed-in client's writes: a booking at any business, a move or a cancel of their own bookings (ADR 0006). A client sign-in grants it, always with the direct header and behind the proxy when the signed scope list names it, and nobody else holds it.

`tools/list` shows the same tools to everyone.

**The client tier as built.** The platform proxy signs the client's Altegio user token into
`x-mcp-auth-altegio-user-token`, with `x-mcp-auth-kind: client` and the client's scope list in
`x-mcp-auth-scope`. The three names are settings (`CLIENT_USER_TOKEN_HEADER`,
`CLIENT_SCOPE_HEADER`, `CLIENT_CALLER_KIND`, see the table above) in case the platform picks other
ones. Behind the proxy, `CALLER_AUTH=required` admits such a signed client; a direct user token is
refused there. The server never sees a phone number or an SMS code and never calls the sign-in
routes. With `mcp:me:read` in the scope list the client can run `me_list_places` and
`me_list_bookings`; the six known-business tools accept the client too; with `mcp:me:book` as
well the client can run `me_book`. Without the sign-in, the two tools answer in band and name it. The user token goes
to Altegio only on the two signed-in routes, `GET /user/companies/yplaces` and
`GET /user/records`, next to the partner token (the one the proxy sends with the client, else the
server's), and never appears in a result or a log. Both routes are undocumented: the contract
recorded from a live run, and the end-to-end run with a real account, are in
[`docs/research/signed-in-routes.md`](docs/research/signed-in-routes.md), and some fields can be
empty. The recorded flow is `me_list_places`, `business_list_dates`, `business_list_time_slots`,
`book_check`, ending at the pre-selected widget link with the usual service and team member; the
client can also book in the chat with the tools below.

**The write tools.** With `mcp:me:book` the signed-in client books at any business that takes
online bookings, one of their own places or one they know by its location id, and moves and
cancels their own bookings (an own place is any business that holds an earlier record of the
client, a cancelled one included). Each tool takes two calls with the same arguments:

| Tool | What it does | Scopes | Annotations |
| --- | --- | --- | --- |
| `me_book` | Books the chosen services, team member and free slot at a business | `mcp:me:read`, `mcp:me:book` | write, not destructive |
| `me_reschedule_booking` | Moves one of the client's upcoming bookings to another free time | `mcp:me:read`, `mcp:me:book` | write, destructive |
| `me_cancel_booking` | Cancels one of the client's upcoming bookings | `mcp:me:read`, `mcp:me:book` | write, destructive |

- **The confirmation step.** The first call checks with the business and returns a preview and a
  `confirmation_token`; nothing is changed. After the client agrees, the second call with the same
  arguments and that token makes the change. The token is valid for 10 minutes, is bound to the
  selection and the sign-in, and works once per instance. `CONFIRMATION_SECRET` is its key: unset,
  each process uses its own random key and a confirmation is valid only on the instance that issued
  it (the client is asked for a new preview elsewhere); set it to share confirmations across
  instances.
- **The widget fallbacks.** What the chat cannot do returns `status: fallback` from `me_book`, with
  a reason (`prepayment`, `membership`, `widget_inactive`, `not_connected`, `not_confirmed` when
  the booking service cannot confirm the booking from here, `required_field`) and the pre-filled
  widget link, or the business contacts when there is no usable form. Nothing is booked in that
  case. A `required_field` fallback also carries `missing_fields`, the names of the fields the
  business requires beyond the client's profile (for example `email`), so the assistant can tell
  the client exactly what is missing; the names are third-party data. For the e-mail the assistant
  asks the client and books again with `me_book`'s optional `email` argument
  ([ADR 0007](docs/decisions/0007-email-in-chat-when-required.md)). A profile without an e-mail is
  sent with the `email` key empty, as the booking widget does, because the create route refuses a
  body without the key at any business (SUP-506,
  [ADR 0009](docs/decisions/0009-email-key-always-sent.md)). The booking form's own custom
  fields are enforced at the preview ([ADR 0008](docs/decisions/0008-booking-form-custom-fields.md)):
  a form with required questions this call did not answer returns `required_field` with
  `form_fields` (code, title, type, required, allowed values), the assistant asks the client and
  books again with `custom_fields`, validated against the form and sent on the create.
- **The assistant-booking gate** (ADR 0006, D3 amended 2026-10-27). With
  `MARKETPLACE_APPLICATION_ID` set, a client books and moves from the chat only at a business
  where that Integrations Hub application (2642, "Altegio.me MCP") is active: Altegio switches it
  on for every location that has Altegio.me, and an owner turns the chat bookings off by removing
  it in Integrations. `me_book` then answers `fallback` with `not_connected` and the widget link,
  `me_reschedule_booking` refuses before any write, and cancelling stays open. The Hub answers 404
  for a removed application exactly as for one never installed, so the gate asks only "is it
  installed". The status is read with the server's own token on the app host
  (`GET /marketplace/salon/{location_id}/application/{application_id}`) and cached per location
  for 10 minutes; when the Hub cannot answer, the booking goes ahead and one
  `installation_gate_unavailable` warning is logged. Unset, every business takes chat bookings.
- **Personal data.** The client's name and phone are read from their Altegio profile for the
  create call only. They are never a tool input and never appear in a result or a log.
- **Evidence.** The routes were recorded from a live create, move and cancel, and the three tools
  ran once at the owner's business through the real app: see the "Writes" section of
  [`docs/research/signed-in-routes.md`](docs/research/signed-in-routes.md).

**What waits for I8**, the platform team's request for the proxy's end-client sign-in on `/me`
(asked 2026-10-08):

- the proxy's own phone and SMS sign-in page with OAuth, so that a client can connect from an
  interactive host;
- the protected-resource metadata and the `_meta["mcp/www_authenticate"]` step-up on the in-band
  refusal, which today only says that a sign-in is needed;
- the partner token the proxy sends with a client, the SMS payer, and the use of the undocumented
  routes, all open with the platform team;
- the end-to-end run from claude.ai, a Phase 6 acceptance item.

Until I8 ships, the client tier is verified on fixtures, with the direct header on a local run and
in the container with a signed client identity. Interactive hosts such as claude.ai and ChatGPT
cannot send a partner token and connect through the platform's sign-in once it ships.

## Local run

Requires Node 26.13.0 (LTS, pinned in `.nvmrc`) or Node 24.22.2, and npm 12.2.2.
With nvm run `nvm use`; install npm with `npm install --global npm@12.2.2`.

```bash
cp .env.example .env
npm ci
npm run dev
```

In another terminal:

```bash
curl -s localhost:8080/health
node examples/list-tools.mjs
```

`GET /health` returns the status, version and commit. `tools/list` lists the twelve tools. Tool
calls reach the Altegio API, so they need the real partner token in `.env`; with the placeholder
token they return an in-band error. `.env.example` sets `CALLER_AUTH=optional`, so these calls
need no caller token; with `CALLER_AUTH=required` send `Authorization: Bearer <partner token>`. Raw HTTP clients must send `Accept: application/json, text/event-stream` on
`POST /mcp`, as the Streamable HTTP transport requires.

To try the client tools without the proxy, keep `CALLER_AUTH=optional` and add the header
`X-Altegio-User-Token: <user token>` to the `tools/call` of `me_list_places` or `me_list_bookings`.
A user token comes from the documented phone-code sign-in run by hand, outside this repository
(steps in [`docs/research/signed-in-routes.md`](docs/research/signed-in-routes.md)); it stays in
`.env` as `ALTEGIO_USER_TOKEN`, only the live suites read it, and no run prints it. Set
`ALTEGIO_E2E_USER=1` next to `ALTEGIO_E2E=1` to run the live suites of the signed-in routes
(see [Checks](#checks)).

## Checks

```bash
npm run check
```

runs lint, format check, typecheck, the Jest tests and the build, in that order. It is the same
set the CI job runs. Tests use Jest with ts-jest, as in Altegio.Pro MCP, and live in
`__tests__/` directories next to the code. Run them with `npm test` or `npx jest <path>`.
ts-jest only transpiles; `npm run typecheck` type-checks the sources and the tests. Jest runs
two workers and replaces one once its heap passes 256 MB, so a full run stays near 1 GB on any
machine; there is no need to add `--runInBand` or `--maxWorkers`.

The compliance suite (`src/compliance`) runs every registered tool through rules R1-R14 and fails
the build when a tool:

- lacks a title or any of the three behaviour hints;
- mixes reads and writes;
- has a name longer than 64 characters or outside the naming pattern;
- has a description that addresses the model with instructions;
- asks for personal data in its inputs;
- uses a write upstream route other than the three client write routes, or a signed-in route
  without the client tier (R14: a tool that writes must require `mcp:me:book`).

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

Two more live suites need a user token (`ALTEGIO_USER_TOKEN` in `.env`) and `ALTEGIO_E2E_USER=1`
as well; they are skipped without both flags. `user-routes.live.test.ts` records the contract of
the two signed-in routes (two upstream calls). `me-flow.live.test.ts` drives the own-place flow
from `me_list_places` to the pre-selected widget link through the real app with the direct user
token header (at most 12 upstream calls, nothing booked):

```bash
ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 node --env-file=.env ./node_modules/jest/bin/jest.js \
  --testPathPatterns=me-flow.live --runInBand
```

It prints the link and the counts and writes them to the git-ignored `loadtest-output/`.

`me-writes.live.test.ts` is the one suite that books. It needs `ALTEGIO_E2E_WRITE=1` as well and
makes ONE real booking at the owner's own business (location 726120 unless
`ALTEGIO_E2E_WRITE_LOCATION` says otherwise), at least two days ahead, through `me_book`, moves it
with `me_reschedule_booking` and cancels it with `me_cancel_booking`, each in its two-call shape, in
at most 30 upstream calls. The business sees the booking and may send its default reminders. A
booking it made and did not see cancelled is cancelled in `afterAll`; it prints
`ME_WRITES_SUMMARY` and writes `loadtest-output/me-writes-run.json`, both holding ids, slot times
and statuses only:

```bash
ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 node --env-file=.env \
  ./node_modules/jest/bin/jest.js --testPathPatterns=me-writes.live --runInBand
```

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

The image is `node:26.13.0-alpine`, built in two stages, installs production dependencies only and
runs as the non-root `node` user. `scripts/smoke.sh IMAGE` starts the image with a canary token
and a proxy key file copied into the container, signs its requests the way the platform proxy does,
and checks `/health`, the signed `/mcp` path, the refusal of an unsigned request, the logs (no token,
no tool arguments), the container user and a clean SIGTERM stop. It runs locally (Docker through Colima on macOS) and in
CI.

## CI and branch rules

Workflow `CI` (`.github/workflows/ci.yml`) runs on pull requests to `main` and on
pushes to `main`. Its `test` job validates Node 26 and Node 24, lint, formatting,
source and browser types, tests, inventory, installed packages, containers and
release ordering. Production dependencies must have no advisories; the full audit
fails at moderate severity. CodeQL runs separately as `analyze`.

Ruleset `default-branch-ci-gate` requires pull requests, resolved review threads,
an up-to-date branch and successful `test` and `analyze` checks. It blocks force
pushes and deletion with no administrator bypass. Only merge commits are allowed.
Independent exact-head review remains required; GitHub approval counts stay at
zero. See [repository settings](.github/REPOSITORY_SETTINGS.md) and the
[applied ruleset](.github/rulesets/main-ci-gate.json).

Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`,
`ci:`, `build:`). A husky `commit-msg` hook checks them locally and CI checks every commit and
the pull request title.

## Deploy

Status: live.

The maintained service is published at `https://mcp.alteg.io/me` through the
platform proxy's anonymous lane. The proxy reaches Cloud Run over HTTPS; the
backend answers `/health` and refuses unsigned `/mcp` requests with 401. The
serving revision is operational state, not a fixed README value: verify it through
`/health` and the ordered release record before assessing a deployment.
Every revision comes from the trigger on `main`; the serving commit is reported by `/health`. What
ran live, with dates and revisions, is in the deployment record in
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

**Caller access.** The deployed revision runs with `CALLER_AUTH=required` (since 2026-10-06, apart
from a few hours of `optional` on 2026-10-12, release 14, reverted in release 15): the proxy's
`/me` lane refuses a call without a partner token, and this server refuses a signed call that
does not carry one, so the account-2630 token no longer serves anonymous callers (rollout in
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
and no client address. Retention is a project-wide setting owned by the platform: the bucket
keeps logs for 30 days (read from the project on 2026-10-05 and again on 2026-10-06; we never change
it). Staff can read the project's logs through the platform's logs MCP, and the proxy
writes its own request line for `/me` (route, tool, method) to the platform's BigQuery dataset
`mcp_requests`, which keeps 90-day partitions. Our logs hold no personal data.

**Labels.** `app=altegio-me-mcp` is set only on the Cloud Run service, the uptime checks and the
alert policies; accounts, the trigger, the secrets and the log-based metrics cannot carry it, so
cost by label covers Cloud Run only and everything else is found by name (runbook, "Resources").

**Timeouts.** One tool call is cut at 25 seconds by the server, below the 60 seconds of Cloud
Run, below the 120 seconds the proxy waits for response headers, below the 240 seconds Claude
allows for a tool call (per the connector documentation at
[claude.com/docs/connectors/building](https://claude.com/docs/connectors/building)).

**MCP SDK.** Split v2 packages; the legacy stateless transport preserves protocol 2025-11-25.

## Cost estimate

Monthly cost of the hosting in the platform's project `altegio-mcp`, in US dollars. Assumptions:
Cloud Run in `europe-west1` (price tier 1) with 1 vCPU and 512 MiB, billed per request, one
minimum instance kept warm; about 3.5 `POST /mcp` requests per tool call at about 0.5 seconds
each; the instance is busy for 175,000 seconds a month at the expected load and for about half of
the month at the peak; about 10 KB of answer per tool call; 20 deploys a month. The server calls
no LLM: the model runs on the AI host's side. The platform proxy in front of the service
(`mcp.alteg.io`, ADR 0002) is the platform's cost and is not counted here. Free allotments are not
subtracted, except for the uptime checks (see below).

The expected column is the MVP assumption the owner set on 2026-10-07: at most 10,000 bookings a
month for the first weeks to months after launch, at about 10 tool calls each. The peak column is
ten times that: the headroom the hosting and the request gate were measured against
([`docs/loadtest/results.md`](docs/loadtest/results.md)), not a forecast. In the MVP peak hour the
gate runs at about a fifth of its ceiling (90 upstream calls a minute per process); capacity is
revisited only if growth exceeds the assumption.

| Item | Expected (MVP, ≤10k bookings ≈ 100k tool calls / month) | Peak (10x headroom, ≈1M tool calls / month) |
|---|---|---|
| Cloud Run: one idle minimum instance, 2,592,000 s at $0.00000375 per second | $9.72 | $9.72 |
| Cloud Run: busy time above the idle rate ($0.0000215 per second) and requests ($0.40 per million) | $3.90 | $29.26 |
| Uptime checks: one (`/health`), every 5 minutes, three regions, 25,920 executions, inside the free allotment the platform's checks leave | $0 | $0 |
| Secret Manager: at most 86,400 secret reads at $0.03 per 10,000 | $0.30 | $0.30 |
| Cloud Logging: 50 GiB a month free, then $0.50 per GiB | $0 | $1 |
| Network egress: first GiB free, then $0.12 per GiB | $0 | $1 |
| Cloud Build: about 6 minutes a deploy at $0.003 per minute, normally inside 2,500 free minutes | $0.40 | $0.40 |
| Artifact Registry: about 4 GiB of images kept, $0.10 per GiB-month after 0.5 GiB | $0.40 | $0.40 |
| **Hosting total** | **≈ $15** | **≈ $42** |
| Product, later: OAuth state store (Firestore), unless the platform proxy holds it (ADR 0002) | $1–5 | $5–15 |
| Product, later: SMS sign-in codes, $0.02–0.10 each | ≈ $20–100 per 1,000 sign-ins | scales with sign-ins |
| Product, later: catalog refresh job, Scheduler, storage | $1–5 | $1–5 |
| Product, later: nightly evals via Anthropic API (optional) | $10–30 | $10–30 |

The one uptime check costs nothing at 5 minutes: it runs 25,920 executions a month and the
platform's own checks leave about 41,000 of the 1,000,000 free monthly executions. At 1 minute it
would run 129,600 and cost about $27, which is why the period is 5 minutes; without any free
allotment it would cost about $8 at 5 minutes. A second, public check was not created: on
2026-10-06 the owner decided to rely on the platform's monitors, which probe `/me` themselves (see
the runbook, "Monitoring"). Alert policies are not charged before September 2027 at the earliest.

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
