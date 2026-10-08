# claude.ai connector run (OPS-08)

Owner step list for adding the server to claude.ai as a custom connector and running the
known-business flow through it. The run is a human step: it needs a claude.ai account of the
owner and the public route. Claude (the agent) prepares the list, then reads the service's own
logs for the run and records the result under "Connector run results".

## Purpose

OPS-08 and ROADMAP success criterion 3: a custom connector in claude.ai that points at
`https://mcp.alteg.io/me` completes the known-business flow (business card, services, team
members, dates, time slots, slot check) and ends with a booking-widget link that opens with the
service, team member and time already selected. Until this run is done, nothing proves that
claude.ai itself, with its own headers, origin and timeouts, can use the server.

The business is location `726120` "BaBarber", the owner's own location where the widget link was
already checked in a real browser (see "Browser check results" in
[`widget-deep-link.md`](widget-deep-link.md#browser-check-results)). The demo location `722227`
is not used: its widget is inactive (`active: 0`), so a link to it would not open a booking form.

## Prerequisites

- The platform's `/me` route is live (open question I5) and the service is deployed (I6). Check
  both before starting:
  - `bash scripts/smoke-url.sh --public https://mcp.alteg.io/me` passes: initialize and
    `tools/list` answer 200, there is no `mcp-session-id`, no redirect, and the protected-resource
    metadata route for `/me` is 404.
  - `GET /health` on the service's `run.app` address reports the commit that was deployed (the
    `commit` field equals the merge commit). `/health` is not reachable through the proxy.
- A claude.ai account of the owner that may add custom connectors (on a team or enterprise plan an
  organization admin may have to allow them).
- A date and time with a free slot at least one day ahead on location `726120`. Claude finds one
  with the tools during the run, so no preparation is needed beyond a free calendar.
- Google Chrome, to open the final link.

## Owner step list

1. Open claude.ai, Settings, Connectors, and add a custom connector. Name it `Altegio.me`, and use
   the URL `https://mcp.alteg.io/me`. Leave the authentication fields empty: the route is
   anonymous. Save. If claude.ai reports an error here, copy the exact text; that is a result too.
2. Start a new chat and enable the connector for it.
3. Send the prompts below one by one, in this order, and wait for each answer. Do not type names,
   phone numbers or e-mail addresses into the chat.
   1. `Show the business card of location 726120.` (expects `business_get`)
   2. `What services does location 726120 offer?` (expects `business_list_services`)
   3. `Who works there?` (expects `business_list_team_members`)
   4. `On which dates in the next two weeks is there free time for a haircut with any team
      member?` (expects `business_list_dates`)
   5. `Show the free time slots on the earliest of those dates, at least one day ahead.` (expects
      `business_list_time_slots`)
   6. `Check that the first of those slots can be booked and give me the link.` (expects
      `book_check`)
4. Open the returned link in Chrome. Check what the widget shows: whether the service, the team
   member and the time are pre-selected, and whether it asks for anything before the confirm step.
   Do not confirm the booking. Close the page.
5. Capture, in one note or a few screenshots:
   - the date and time of the run, with the time zone;
   - the whole conversation as a transcript or as screenshots (the tool calls claude.ai shows
     under each answer);
   - the final link;
   - what the widget showed pre-selected;
   - any error text, from claude.ai or from a tool, copied exactly.
6. Give the capture to Claude with the run's date and time. Claude reads the logs for that window
   (next section) and fills in "Connector run results".

## What Claude checks in the logs

The service writes one `mcp_call` line per `POST /mcp` to Cloud Logging in project `altegio-mcp`,
and none of them carries tool arguments, a token or a client address. For the run's time window,
read them through the platform's logs MCP or, with access, with a read-only query:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="altegio-me-mcp" AND jsonPayload.event="mcp_call" AND timestamp>="START" AND timestamp<="END"' --project=altegio-mcp --format=json
```

What each field answers:

| Field | What Claude looks for |
| --- | --- |
| `rpc_method`, `tool` | The count of `initialize`, `tools/list` and `tools/call` per tool call, and that all six tools were called in order. The count per tool call says whether claude.ai starts a fresh session per call (the cost estimate assumes about 3.5 requests per tool call) |
| `origin_host` | Empty for a request without an `Origin`; when claude.ai sends one, its host is logged only if it was refused. Any value here means the origin allow-list needs a change |
| `forwarded_for_count` | How many addresses `X-Forwarded-For` carried. It confirms the value of `TRUSTED_PROXY_HOPS` for the real proxy path (1 expected) |
| `http_status`, `outcome` | Every call of the run is 200 and `ok`; any 401, 403, 429 or 5xx is explained |
| `limited_by` | Empty. A value means one of our own limits (`inflight`, `ip`, `pool`, `gate`) cut a request of a single run, which is wrong |
| `upstream_kind` | Empty. A value (`unauthorized`, `rate_limited`, `unavailable`) means the Altegio API refused or failed |
| `latency_ms`, `mcp_client`, `protocol_version` | Latency of each call against the 25 s tool deadline, the client name claude.ai reports and the protocol version it negotiates |

If the run fails before any line appears, Claude checks the proxy side through the platform
(whether the request reached the proxy at all) before suspecting the service.

## Connector run results

Run: 2026-10-06 15:28:25 to 15:31:20 UTC (tool calls; the owner's machine clock is UTC+7, so 22:28 to 22:31 local). The connector was added at about 15:26 UTC.
Revision: `altegio-me-mcp-b32ak5r5qmvb57g246qju3odyua` (version 0.2.0, release sequence 2), serving 100% of traffic.
Commit: 4c781e6 (`/health` on the `run.app` address reported `4c781e6f68813f16af7b5ebef49ac7ee51191283`; every `mcp_call` line of the window carries the same commit).
Connector: `https://mcp.alteg.io/me`, anonymous, added as a custom connector in the Altegio organization's Claude account (an organization owner adds custom connectors there). Location 726120 "BaBarber", Europe/Warsaw.
Evidence: the owner's transcript and a screenshot of the widget, kept locally and not committed (git-ignored): `.planning/phases/03-hosting-and-launch-safeguards/evidence/03-16-claude-connector-transcript.md` and `03-16-widget-preselected.png` in the same folder. The log reading is the read-only `gcloud logging read` query above, for 15:20:00Z to 15:35:00Z.

Each row is one prompt of the step list. Every call was one `POST /mcp` with `http_status` 200, `outcome` ok, `limited_by` and `upstream_kind` empty, `protocol_version` 2025-11-25, and `latency_ms` far below the 25 s tool deadline.

| Step | Asked | Result | Observation |
| --- | --- | --- | --- |
| business_get | Show the business card of location 726120 | pass | 15:28:25Z, 183 ms. Name, premium barbershop in Warszawa, time zone Europe/Warsaw, currency zł, online booking enabled and widget active, two booking forms. It also reported "next free slot today 17:30" (see the content observations) |
| business_list_services | What services does location 726120 offer | pass | 15:29:27Z, 677 ms. 21 bookable services with prices, among them Classic Haircut 700 zł |
| business_list_team_members | Who works there | pass | 15:29:53Z, 181 ms. Seven team members, all bookable online. The answer said none of them has a next free date, which differs from the card (see the content observations) |
| business_list_dates | On which dates in the next two weeks is there free time for a haircut with any team member | pass | 15:30:20Z, 152 ms. Every day from 6 to 20 October, and also 21 October, one day past the two weeks asked (see the content observations) |
| business_list_time_slots | Show the free time slots on the earliest of those dates, at least one day ahead | pass | 15:30:49Z, 307 ms. Wednesday 7 October, Classic Haircut with any barber, every 30 minutes from 09:00 to 21:00 (25 slots) |
| book_check | Check that the first of those slots can be booked and give me the link | pass | 15:31:20Z, 1267 ms. Slot confirmed as bookable, link `https://n1472304.alteg.io/company/726120?o=m-1s13884490d2607100900` returned |
| widget | Open the returned link in Chrome (owner) | pass | The link redirected to `/company/726120/personal/menu?o=m-1s13884490d2607100900` |

What the widget showed pre-selected: "Any available professional", "Wednesday, 7 October 9:00" and, under Services, "Classic Haircut 700 zł", with the Continue button active. Nothing had to be chosen again before the contact step. No booking was made.

Observations from the service's own log (not failures; the flow completed):

- **Origin.** `origin_host` is empty on every line of the window, so no origin was refused and the allow-list needs no change (`EXTRA_ALLOWED_ORIGINS` stays as it is). Whether claude.ai sends an `Origin` header at all is not visible: an allowed origin is not logged.
- **X-Forwarded-For.** `forwarded_for_count` is 1 on every line, which matches `TRUSTED_PROXY_HOPS` as configured (no change).
- **POSTs per tool call.** The client keeps no session. After a handshake of three POSTs (`initialize`, `notifications/initialized`, `tools/list`, 15:28:13Z to 15:28:14Z) each of the six tool calls was a single POST. Over the whole session, including the handshakes made while the connector was being added, claude.ai produced 20 lines for 6 tool calls (about 3.3 per call, near the 3.5 of the cost estimate); in steady state it is 1 per call.
- **Errors at our edge.** None: no 401, 403 or 429 from either client in the window.
- **Protocol version.** Three requests (15:26:43Z, 15:26:46Z and 15:28:12Z) carried `MCP-Protocol-Version` 2026-07-28 and were answered 400 `protocol_error`, because the installed MCP SDK 1.32.0 lists 2025-11-25 as its newest version. Each was followed within about 0.5 s by a fresh `initialize`, and the client then used 2025-11-25. Follow-up before directory submission: upgrade the SDK so the newer version is accepted, then repeat the run and read the log again.
- **Other client.** Lines with `mcp_client` "other" (protocol 2025-03-26, a handshake and `business_get` every four to six minutes since before the connector existed) are not part of this run; they look like the platform's own canary.

Content observations from the transcript (separate tickets, not failures of this check):

1. `business_get` reported a next free slot "today 17:30", while `business_list_team_members` showed no next free date for any of the seven team members.
2. `business_list_dates` returned 21 October, one day past the two weeks requested.

Owner review: 2026-10-06, owner ran the six prompts in claude.ai (Altegio organization account) and confirmed in Chrome that the widget showed Any available professional, Wednesday 7 October 9:00 and Classic Haircut pre-selected
