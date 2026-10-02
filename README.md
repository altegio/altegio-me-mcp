# Altegio.me MCP Server

Status: planning. There is no code yet. Requirements and the roadmap are being produced with
[GSD](https://github.com/open-gsd/gsd-core) from the research and decisions in [`docs/`](docs/).

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

## Architecture (planned)

```
AI host (Claude, ChatGPT, ...)
        │  MCP over Streamable HTTP, stateless
        ▼
altegio-me-mcp on Cloud Run  ──►  Altegio public booking API (api.alteg.io/api/v1, partner token)
        │
        ├──►  Catalog index of bookable businesses (refreshed by a scheduled job)
        └──►  Phase 2: OAuth 2.1 authorization server, phone + SMS sign-in
```

- TypeScript, `@modelcontextprotocol/sdk`, Express. Patterns reused from Altegio.Pro MCP: tool
  factory with zod schemas, annotations on every tool, untrusted-text fencing, pagination,
  actionable errors, CI layout.
- Runs on its own Cloud Run service in its own GCP project, on a domain that matches the
  brand (for example `mcp.altegio.me`, to be confirmed). It does not sit behind the
  `mcp.alteg.io` proxy, which only admits Altegio account holders.
- Decisions and their reasons: [`docs/decisions/0001-scope-and-architecture.md`](docs/decisions/0001-scope-and-architecture.md).
- What other teams must answer before or during the build: [`docs/open-questions.md`](docs/open-questions.md).

## Research

| Topic | File |
|---|---|
| Altegio public booking API, discovery, deep links, limits | [`docs/research/altegio-booking-api.md`](docs/research/altegio-booking-api.md) |
| Distribution on AI platforms and their requirements | [`docs/research/ai-platforms-distribution.md`](docs/research/ai-platforms-distribution.md) |
| How Altegio.Pro MCP is built, what to reuse | [`docs/research/altegio-pro-mcp-reference.md`](docs/research/altegio-pro-mcp-reference.md) |
| The `mcp.alteg.io` platform and why we don't use it | [`docs/research/mcp-platform-reference.md`](docs/research/mcp-platform-reference.md) |

## Environment variables (planned)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (Cloud Run sets it) |
| `ALTEGIO_API_BASE` | Default `https://api.alteg.io/api/v1` |
| `ALTEGIO_PARTNER_TOKEN` | Partner token of the Altegio.me MCP developer account (Secret Manager) |
| `PUBLIC_BASE_URL` | Public URL of the server, used in links and OAuth metadata |
| `LOG_LEVEL` | `info` by default |

The final list lands with the first code. Secrets live in GCP Secret Manager, never in git.
See [`.env.example`](.env.example).

## Local run and deploy

Local run instructions arrive with the first phase. Deploys go only through git: a Cloud Build
trigger on merge to `main` deploys to Cloud Run. No manual `gcloud run deploy`.

## Cost estimate (rough, refined per phase)

Assumptions: Cloud Run in `europe-west1`, 1 vCPU / 512 MiB, one minimum instance (OAuth
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

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- Once code lands: CI workflow with a `test` job, and a ruleset on `main` (pull requests only,
  required check `test`, no force-push, bypass for organization admins).
- GSD planning output (`.planning/`) stays out of git unless the team agrees otherwise.

## Owner

Mike Kondakov ([@mkondakov](https://github.com/mkondakov)). Questions: Slack `#dev-ai-coding`.
