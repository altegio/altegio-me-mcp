# Open questions

Questions this project cannot answer on its own, grouped by who can answer them. Update the
status column as answers arrive and record the answer (or a link to it) below each table.

## Backend team (biz.erp)

| # | Question | Blocks | Status |
|---|---|---|---|
| B1 | Catalog source: may we build an index of all businesses with online booking enabled? From `GET /companies` (logged as suspicious, 100 requests / 10 s, no text or geo filters), from the analytics replica, or will the backend expose a search endpoint? | Phase 1 | open |
| B2 | Opt-out: where is the "don't list me in AI assistants" flag stored and how do we read it? | Phase 1 | open |
| B3 | A dedicated partner type for the MCP (like `google_maps`): per-partner rate limits, exemption from the per-IP limit, behaviour of the anti-fraud checks (412 with `X-App-Security-Level`, fake 201 bookings) for server-to-server traffic. Can we forward the end user's IP? | Phase 1 launch | open |
| B4 | Deep-link pre-selection format `?o=m{staffId}s{serviceId}d{YYDDMMHHmm}` from `client.booking`: is it stable and supported for external links? | Phase 1 | open |
| B5 | Contract status of the undocumented `POST /booking/search/*` and `/booking/locations/{id}/attendances/calculate` routes the widget uses. May we depend on them? | Phase 1 (nice to have) | open |
| B6 | SMS for sign-in: who pays, the business (`book_code`) or Altegio (`/booking/yplaces/code`)? May our partner use `/booking/yplaces/auth`, given it sends nothing to phones that are not yet a client anywhere? | Phase 2 | open |
| B7 | Behaviour when a service requires prepayment or a membership and the booking is made through the API. | Phase 2 | open |

## Legal and product

| # | Question | Blocks | Status |
|---|---|---|---|
| L1 | Listing businesses in AI assistants without explicit opt-in: acceptable under our terms and GDPR? Required notice to businesses? | Phase 1 | open |
| L2 | Privacy policy and terms of service for the AI booking product (data categories, retention, sharing with AI hosts, contact). Required by every directory. | Submission | open |
| L3 | Health data: confirm medical and health business types stay excluded, and how to classify them. | Phase 1 | open |
| L4 | OpenAI business identity verification and the list of target countries; ChatGPT plugin availability in the EEA, UK and Switzerland. | ChatGPT submission | open |

## Design and marketing

| # | Item | Needed for | Status |
|---|---|---|---|
| D1 | Product name for listings, icon and logo | Submission | open |
| D2 | 3–5 screenshots (≥1000 px wide), demo video | Claude (MCP Apps), ChatGPT | open |
| D3 | Demo business with realistic services, team and schedule; demo account without 2FA | Submission, evals | open |
| D4 | Public docs page and support contact | Submission | open |

## Infrastructure

| # | Question | Blocks | Status |
|---|---|---|---|
| I1 | GCP project and billing account for the service | First deploy | open |
| I2 | Domain: `mcp.altegio.me` or another; DNS owner | First deploy | open |
| I3 | Developer account and partner token for the Altegio.me MCP | Local run against the real API | open |
