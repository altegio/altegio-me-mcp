# ADR 0005: Own places first; the catalog is parked

- Status: accepted
- Date: 2026-10-08
- Deciders: Mike Kondakov, after the 2026-10-07 1-1 with Yri Petrou (platform owner)
- Amends: [ADR 0001](0001-scope-and-architecture.md) D2 (phase order) and D4 (catalog, parked),
  and [ADR 0004](0004-caller-authorization-tiers.md) D6 (interactive hosts no longer wait for a
  later phase: the client tier is the core of milestone v1)

## Context

Phase 3 shipped the six known-business tools at `https://mcp.alteg.io/me` with partner-token
admission. The next planned phase was a searchable catalog of every bookable business, built
by crawling `GET /companies` nightly into an own index (ADR 0001 D4, requirements CAT-01..08).

Three findings changed that plan:

- **An index by API crawl is the wrong architecture.** The platform owner's position: data for
  fuzzy search, grouping and ranking belongs in a store built for it (ClickHouse or Elastic),
  fed from the database by the development team and read through a direct connector, not by
  paging an HTTP API. Such an index needs developers and is a separate project.
- **Broad search has no real distribution.** "Connect Altegio to your assistant and search for
  places" is an odd case for a client; the assistants' own place search (Fresha, Booksy and
  Google-backed cards in ChatGPT) runs on data the hosts hold themselves, not on a partner's
  MCP. Building search to get on the hosts' radar is synthetic work that rarely lasts.
- **The Reserve with Google feed is not a shortcut.** It is opt-in (about 6,000 of 14,200 active
  locations enable it) and cut further by Google's rules (2,797 merchants reach Google), so it
  covers a quarter of the bookable base for reasons that do not apply to an assistant.

What already works and has users: the Altegio.me app's own case, a client booking at the places
they already go to. The API covers it (phone sign-in on `/user/auth`, the client's places,
their records), and the platform proxy already holds signed-in user tokens for Altegio.Pro MCP.
What the app lacks are the tasks an assistant can do better: book two people side by side,
watch a favourite team member's calendar for a freed slot, hold a slot and release it in time.

## Decision

**D1. The core of milestone v1 is booking at the client's own places,** as in the Altegio.me
app. The client signs in once; the assistant lists their places and bookings and books at one of
them with the usual service and team member proposed. The known-business tools of Phase 2 stay
as they are: "own places" is a use case on top of them, not a new architecture.

**D2. The catalog and broad search are parked.** No crawl of `GET /companies`, no own index, no
GCS snapshot, no asks to the backend for feeds, flags or search endpoints. Requirements
CAT-01..08 move to v2 and stay there until a development-team index exists. Scenarios outside
the client's own places would use `GET /companies` as it is (its `city_id` and
`business_type_id` filters) and are not in v1 (owner decision 2026-10-08); a client without
history at a business gives a link or an id, as today. *Amended 2026-10-12 (owner decision): a
client is never asked for a location id or a link, since they have no way to know either. The
`business_search` tool takes the business name, the city and the country, resolves the city
from the reference routes (`GET /countries`, `GET /cities`) and lists the city's businesses with
`GET /companies?city_id=` as it is, at most three pages of 1000, matching the name on the server;
the lists are reused for a while per process and nothing is indexed or stored. Still no crawl, no
own index, no asks to the backend; the catalog stays parked.*

**D3. The widget stays the completion step.** *Amended 2026-10-08 by [ADR 0006](0006-in-chat-booking-at-own-places.md): at own places the booking is created, moved and cancelled in the chat; the widget remains for prepayment, membership, an inactive widget and foreign places.* Booking at an own place ends in the pre-filled
widget link (`book_check` plus the deep link), not in an in-chat `book_record`. Writes with the
user token (`book_record`, cancel, reschedule) come only with the slot-hold case if its research
says go, under the write-confirmation and anti-fraud rules already listed for them (WRITE-01,
WRITE-04, WRITE-07).

**D4. Added-value cases are researched before they are planned.** Three candidates: two people
side by side (one business, two services or team members, one common time, two pre-filled
links); freed-slot monitoring at a favourite team member (mechanism to be chosen: the host's
scheduled runs or a small server-side watcher); slot hold (keep a booking N weeks ahead, release
by a deadline unless confirmed). The research records API coverage, state and scheduling needs,
host capabilities and a go/no-go per case. The API is not changed for the first two cases
(platform owner, 2026-10-07). Each shipped case comes with MCP prompt/skill text that tells the
assistant the case exists and how to run it.

**D5. Client sign-in is the platform proxy's OAuth flow,** as ADR 0004 D4 decided: the proxy is
the authorization server on `mcp.alteg.io`, hosts the phone + SMS page, keeps the user token and
forwards it signed; this server authorizes each tool by scope (`mcp:me:read`, `mcp:me:book`).
The phone number and the SMS code never pass through the chat or a tool. The ask to the platform
team (I8) is raised after the case research, so it names the scopes and tools the cases need.

**D6. Distribution is the Claude Connectors Directory listing plus promo inside the Altegio.me
app** (a banner and a short video with the example cases), so clients add the connector from the
directory rather than through "add custom connection". The directory submission moves after the
first case ships, not before.

## Consequences

- The roadmap phases 4 to 6 are rewritten: Phase 4 client sign-in and own places (ME-01..05),
  Phase 5 added-value cases (CASE-01..05, research first), Phase 6 directory listing and promo
  (LIST-01..09). The former Phase 4 is parked; its research
  ([`research/catalog-source.md`](../research/catalog-source.md)) stays on record.
- Open questions B1, B2 and L1 (catalog source, opt-out flag, listing without opt-in) are parked
  with the catalog; the crawl question posted to the platform owner on 2026-10-07 is withdrawn.
  New: I8 (end-client OAuth on the `/me` lane) and B6 (SMS cost) move onto the critical path.
- The health-type exclusion (L3, decided 2026-10-07) still applies to the by-id tools and to the
  compliance answer, not to a catalog.
- Milestone v1's success metric changes: not "a search-to-widget connector accepted into the
  directory" but "a signed-in client books at their own places and gets at least one case the
  app lacks, listed in the directory and promoted in the app".
- The partner-token tier of ADR 0004 is unchanged; the known-business tools keep serving partner
  callers without a client sign-in.
- Risks carried forward: ChatGPT's rule against collecting OTP codes through tools (met by the
  proxy's own page), SMS cost per sign-in (B6), anti-fraud behaviour on writes if the slot-hold
  case ships (B3, WRITE-07), and the proxy's OAuth being platform work on the critical path.
