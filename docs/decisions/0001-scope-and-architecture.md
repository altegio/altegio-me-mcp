# ADR 0001: Product scope and architecture

- Status: accepted
- Date: 2026-10-02
- Deciders: Mike Kondakov

## Context

Clients of businesses that use Altegio should be able to book appointments through AI assistants
and their agents. Research findings ([`docs/research/`](../research/)):

- The Altegio public booking API (`book_*` routes) already covers the flow for a known business
  with a partner token only. No per-business installation is needed. Each business controls
  which services and team members are bookable online.
- There is no API to search businesses across the network (by text, location or category).
  Altegio.me is a landing page, not a catalog.
- End clients sign in only with a phone code that returns a `user_token`. There is no OAuth for
  end clients. ChatGPT forbids collecting SMS/OTP codes through tools, so a code typed into the
  chat is not an option.
- The `mcp.alteg.io` proxy admits only Altegio account holders. It has no anonymous lane and no
  phone sign-in.
- Directory precedents (Fresha, Resy, Booking.com) search and show availability in chat and hand
  the final step off to their own site.
- Altegio.Pro MCP reserves B2C booking for a separate server (its ADR D1).

## Decisions

**D1. Separate product and repository.** `altegio/altegio-me-mcp`, private. Separate release
cycle, branding and directory listings from Altegio.Pro MCP.

**D2. Phase 1 hands the booking off to the widget.** Tools search, browse and check availability
without sign-in. The last tool verifies the slot (`book_check`) and returns a deep link to the
business's booking widget with service, team member and time pre-selected. No personal data is
collected in chat. Phase 2 adds in-chat booking after OAuth 2.1 sign-in with phone + SMS on an
Altegio.me page, plus "my bookings", reschedule and cancel.

**D3. Standalone hosting on Cloud Run.** Own GCP project, own Cloud Run service, own domain that
matches the brand (candidate `mcp.altegio.me`). Reasons: the shared proxy would need an anonymous
lane and a phone identity provider owned by another team; Claude's reviewers expect the server
domain to match the service; the stateless MCP transport fits Cloud Run. Request logging,
rate limits and abuse protection are ours to build.
*Amended 2026-10-04 by [ADR 0002](0002-public-address-on-platform-proxy.md): the public address
is `https://mcp.alteg.io/me` through the platform proxy; `mcp.altegio.me` is dropped.*

**D4. Catalog covers every business with online booking enabled, with opt-out.** We build our own
searchable index (name, location, category) and refresh it on a schedule. Needs sign-off from the
backend team (data source and access pattern) and from legal (listing businesses without an
explicit opt-in, the opt-out mechanism). The data source and storage are open; see
[`docs/open-questions.md`](../open-questions.md).

**D5. Launch scope defaults.** Altegio only (no YCLIENTS). Medical and health business types are
excluded at launch: ChatGPT bans health data and Claude's submission asks about it. Group events
come after single appointments.

**D6. Stack and conventions follow Altegio.Pro MCP.** TypeScript, `@modelcontextprotocol/sdk`,
Express, zod. Reuse: tool factory, annotations on every tool, untrusted-text fencing, pagination
shape, actionable errors, CI layout. The server is stateless. Target protocol `2025-11-25` and
stay compatible with `2026-07-28` (stateless transport, CIMD).

**D7. Tool rules for directory review.** Every tool has a `title` and all of `readOnlyHint`,
`destructiveHint` and `openWorldHint`. No tool mixes reads and writes. Descriptions carry no
instructions aimed at the model beyond what the tool does. Errors name the next action.

**D8. Distribution order.** Claude Connectors Directory, then ChatGPT plugins (after confirming
EU availability and verifying the business identity), then the MCP Registry. Perplexity, Mistral
and xAI through direct contact. Google through a partnership and the existing Reserve with
Google / Actions Center integration; consumer Gemini has no public submission.

## Consequences

- Phase 1 needs no identity system and can ship before the backend answers the sign-in questions.
- The catalog is the critical path: without a data source agreement there is nothing to search.
- A dedicated partner type is needed before launch: all traffic comes from our IPs, and the
  per-IP limit (200 requests/min) and anti-fraud checks would otherwise block us.
- Phase 2 requires an OAuth authorization server of our own, with CIMD and DCR, PKCE S256 and a
  phone + SMS login page. *Reopened by [ADR 0002](0002-public-address-on-platform-proxy.md): on
  `mcp.alteg.io` the platform proxy is the authorization server, so Phase 2 sign-in is designed
  with the platform team.*
