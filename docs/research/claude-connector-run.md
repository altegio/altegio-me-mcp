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

Run: pending
Owner review: pending
