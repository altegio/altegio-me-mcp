# Open questions

Questions this project cannot answer on its own, grouped by who can answer them. Update the
status column as answers arrive and record the answer (or a link to it) below each table.

## Backend team (biz.erp)

| # | Question | Blocks | Status |
|---|---|---|---|
| B1 | Catalog source: may we build an index of all businesses with online booking enabled? From `GET /companies` (logged as suspicious, 100 requests / 10 s, no text or geo filters), from the analytics replica, or will the backend expose a search endpoint? | Phase 1 | not asked: answered by own research 2026-10-03 |
| B2 | Opt-out: where is the "don't list me in AI assistants" flag stored and how do we read it? | Phase 1 | not asked: postponed by owner, opt-out in a later version |
| B3 | A dedicated partner type for the MCP (like `google_maps`): per-partner rate limits, exemption from the per-IP limit, behaviour of the anti-fraud checks (412 with `X-App-Security-Level`, fake 201 bookings) for server-to-server traffic. Can we forward the end user's IP? | Phase 1 launch | not asked: owner starts with current limits, ask when limits are hit |
| B4 | Deep-link pre-selection format `?o=m{staffId}s{serviceId}d{YYDDMMHHmm}` from `client.booking`: is it stable and supported for external links? | Phase 1 | not asked: verified by own research 2026-10-03, confirmed in a real browser 2026-10-04 |
| B5 | Contract status of the undocumented `POST /booking/search/*` and `/booking/locations/{id}/attendances/calculate` routes the widget uses. May we depend on them? | Phase 1 (nice to have) | deferred (not asked in Phase 1) |
| B6 | SMS for sign-in: who pays, the business (`book_code`) or Altegio (`/booking/yplaces/code`)? May our partner use `/booking/yplaces/auth`, given it sends nothing to phones that are not yet a client anywhere? | Phase 2 | deferred (not asked in Phase 1) |
| B7 | Behaviour when a service requires prepayment or a membership and the booking is made through the API. | Phase 2 | deferred (not asked in Phase 1) |

B1 answer (own research, 2026-10-03): crawl the public `GET /companies` nightly with our own partner token and build the index from it; exclude health businesses by business group and type ids; the BI replica is used only for cross-checks. The owner still has to decide on the health-adjacent types 35, 25, 29, 17, 28 and on group 9 "unknown". Details in [research/catalog-source.md](research/catalog-source.md).

B2 decision (owner, 2026-10-03): postponed; the opt-out comes in a later MCP version, so nothing was asked of the backend team.

B3 decision (owner, 2026-10-03): start with the current limits and ask the backend team for a dedicated partner type or higher limits when we actually hit them.

B4 answer (own research, 2026-10-03): the pre-selection format is safe to use in v1 with a fallback link to the default booking form; it has been stable since 2020-12 and the grammar is `?o=m{staffId}s{serviceId}[s…]d{YYDDMMHHmm}` (day before month, `m-1` means any professional). The real-browser check stays in Phase 2 (BOOK-04). Details in [research/widget-deep-link.md](research/widget-deep-link.md). Browser check on 2026-10-04 (location 726120, reviewed by the owner the same day): the widget landed with service, team member and time pre-selected for single-named, multi-services and any-member links and opened the plain booking-form link with nothing pre-selected, while a slot after a daylight-saving change lost its time, which the builder already covers by returning the plain link; see "Browser check results" in [research/widget-deep-link.md](research/widget-deep-link.md#browser-check-results).

## Legal and product

| # | Question | Blocks | Status |
|---|---|---|---|
| L1 | Listing businesses in AI assistants without explicit opt-in: acceptable under our terms and GDPR? Required notice to businesses? | Phase 1 | answered 2026-10-03 |
| L2 | Privacy policy and terms of service for the AI booking product (data categories, retention, sharing with AI hosts, contact). Required by every directory. | Submission | not asked: legal questions skipped by owner for now |
| L3 | Health data: confirm medical and health business types stay excluded, and how to classify them. | Phase 1 | answered 2026-10-03 |
| L4 | OpenAI business identity verification and the list of target countries; ChatGPT plugin availability in the EEA, UK and Switzerland. | ChatGPT submission | open |

L1 answer (owner, 2026-10-03): listing every business that has online booking enabled, without explicit opt-in, is acceptable. An opt-out is provided; businesses are not notified.

L3 answer (owner, 2026-10-03): medical and health businesses are excluded at launch, classified by their Altegio business category. The category list will live in config (Phase 4). Known-business tools (Phase 2): `business_get`, `business_list_services`, `business_list_team_members`, `business_list_dates`, `business_list_time_slots` and `book_check` accept any location id and do not filter by business type; Phase 4 (CAT-05) applies the same excluded-type list to these by-id tools, not only to search, before launch.

## Design and marketing

| # | Item | Needed for | Status |
|---|---|---|---|
| D1 | Product name for listings, icon and logo | Submission | owner: Mike Kondakov, decides later |
| D2 | 3–5 screenshots (≥1000 px wide), demo video | Claude (MCP Apps), ChatGPT | owner: Mike Kondakov, decides later |
| D3 | Demo business with realistic services, team and schedule; demo account without 2FA | Submission, evals | owner: Mike Kondakov, decides later |
| D4 | Public docs page and support contact | Submission | owner: Mike Kondakov, decides later |

D1-D4 are decided by the owner, Mike Kondakov, before Phase 5, not by a design or marketing team.

## Infrastructure

| # | Question | Blocks | Status |
|---|---|---|---|
| I1 | GCP project and billing account for the service | First deploy | not asked: answered from Altegio.Pro MCP setup 2026-10-03 |
| I2 | Domain: `mcp.altegio.me` or another; DNS owner | First deploy | not asked: answered from Altegio.Pro MCP setup 2026-10-03 |
| I3 | Developer account and partner token for the Altegio.me MCP | Local run against the real API | not asked: owner decision 2026-10-03 (account 2630) |
| I4 | Organization admin on standby to apply the main-branch ruleset if GitHub refuses the OrganizationAdmin bypass actor to a repo admin | Phase 1 CI gate (CI-02) | not asked: ask only if applying the ruleset fails (plan 01-08) |

I1 answer (from the Altegio.Pro MCP and mcp.alteg.io platform setup, 2026-10-03): a new GCP project `altegio-me-mcp` in europe-west1. Creating the project, linking billing and connecting the GitHub organization to Cloud Build need organization or infrastructure rights. Details in [research/infrastructure.md](research/infrastructure.md).

I2 answer (from the Altegio.Pro MCP and mcp.alteg.io platform setup, 2026-10-03): `mcp.altegio.me` as a Cloud Run domain mapping with a non-proxied Cloudflare CNAME to `ghs.googlehosted.com`. It needs a Search Console owner of `altegio.me` and Cloudflare write access to that zone; the `altegio.me` registration expires 2026-11-22. Details in [research/infrastructure.md](research/infrastructure.md).

I3 answer (owner decision, 2026-10-03): use the partner token of the existing developer account 2630 "Altegio AI", the account that holds Altegio.Pro MCP, Knowledge MCP and Integrations Hub MCP. No new developer account, app or marketplace listing. Accepted trade-offs: per-partner rate limits and anti-fraud state are shared with Altegio.Pro MCP, and the token cannot be revoked independently. Locally the token lives in `.env` (never committed); in production it lives in Secret Manager (Phase 3). This supersedes the dedicated-account proposal in [research/infrastructure.md](research/infrastructure.md) section I3.
