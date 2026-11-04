# ME operational contract

ME is stateless and admits callers by their own Altegio partner token (ADR 0004;
`CALLER_AUTH=required` in production since 2026-10-06); Pro is
authenticated/stateful. ME has eleven tools: eight that read (six for a known
business, plus `me_list_places` and `me_list_bookings` for a signed-in client)
and three that write for a signed-in client at their own places, with the user
token and only after a confirmed preview: `me_book`, `me_reschedule_booking` and
`me_cancel_booking` (ADR 0006, scope `mcp:me:book`). `book_check` and the
fallbacks of `me_book` hand what the chat cannot do to the booking widget. No
OAuth page, catalog search or customer VM autoheal is introduced here.

## Signals and publication gate

- Liveness: backend `GET /health`, HTTP 200, `status=ok`, `service=altegio-me-mcp`,
  package `version` and deployed `commit`. It performs no upstream API call.
- Protocol: signed HTTPS `initialize` with protocol `2025-11-25`, then
  `tools/list`; valid JSON-RPC results, precisely the eleven documented tools
  (six known-business tools, `me_list_places`, `me_list_bookings`, `me_book`,
  `me_reschedule_booking` and `me_cancel_booking`), object input schemas and no
  `mcp-session-id`. Direct unsigned `/mcp` remains 401. **The platform owner must
  update the central monitor's tool list before this release is deployed**: if it
  pins the earlier eight (or nine) tools, the protocol check fails on the first
  probe after the deploy. The change is the platform's; this repository only
  states the catalog.
- Functional: a separate read-only `business_get` for `location_id=722227` through
  trusted ingress. Require a valid result and `isError != true`; do not log its
  contents. Upstream unauthorized/rate-limited/unavailable outcomes are distinct
  from failed liveness. A protocol check cannot prove the partner token works.

The release image gate (`scripts/image-gate.sh`) uses the actual production
container, required proxy authentication, a controlled HTTPS terminating proxy,
certificate validation and the real v1 HMAC format. Its fixed TLS private key is
only a localhost test fixture; the proxy signing key is random per run. It makes
no Altegio API calls and needs no production signing-secret access for the build
account. CI also checks absent/malformed key boot failures and secret redaction.
`python3 scripts/verify-backend.py <run.app HTTPS URL> <deployed commit>` uses
existing operator access to the ME signing key and prints only probe outcomes.
It checks all three signals and unsigned 401. The tagged production candidate separately proves both real mounts boot, correct
commit/liveness and unsigned rejection. An operator/central monitor must verify
real signed HTTPS protocol and the functional canary after deployment.

**Do not publish `/me` until the central monitoring implementation is deployed
and its checks are ready.** A merged monitoring PR is insufficient. Platform owns
publication and must verify deployed backend commit, protocol, canary and monitoring
revision. Monitoring owns alerts/probes. Customer Cloud Run failures must never
feed staff VM autoheal. This repository does not create or drill central alerts.

## The write tools

`me_book`, `me_reschedule_booking` and `me_cancel_booking` write at the signed-in
client's own places with the client's user token, in two calls each: a preview
that changes nothing and returns a `confirmation_token`, then the change with the
same arguments and that token. They need the client sign-in with `mcp:me:book`;
anyone else gets an in-band refusal with no upstream call.

- **`CONFIRMATION_SECRET`** is the key of the confirmation tokens (32 to 512
  printable characters, a secret like the signing keys). Unset, each process uses
  a random key of its own, so a confirmation is valid only on the instance that
  issued it, and the client is asked for a new preview when another instance
  answers. Set it to share confirmations when more than one instance serves.
  Cloud Run is capped at one instance (see below), so the unset default holds
  today.
- **Replay window.** A token is valid for 10 minutes and is redeemed once per
  instance; a second use is refused with no upstream call. Across instances the
  window is only closed by the API itself, which refuses a second booking at the
  same time.
- **Anti-fraud.** The create route may refuse a call from a cloud address with
  HTTP 412 and an `X-App-Security-Level` header, or answer 201 with no record id.
  `me_book` then returns an in-band fallback (`status: fallback`, reason
  `not_confirmed`) with the pre-filled widget link, never an error. Because it is
  a result and not an error, its call-log line shows `outcome` ok and no
  `upstream_kind`, so a log alert keyed on `upstream_kind` `anti_fraud` does not
  see it; a refused move or cancel is an error and does carry `upstream_kind`
  `anti_fraud`. A local run saw none; the Cloud Run egress is untested
  (WRITE-07, B3).
- **Evidence.** The owner's live run of the three tools on 2026-10-08 is in
  `docs/research/signed-in-routes.md` ("Tool run"). It books a real appointment at
  the owner's business and cancels it.

## Scheduled host runs

The `watch_for_a_free_slot` prompt makes the client's AI host run a scheduled task, daily by
default and at most hourly, that watches a team member's free times. On this server such a run is
an ordinary sequence of read calls: `business_list_dates`, then `business_list_time_slots` for each
date with free time, and no `me_` tool. A `me_book`, `me_reschedule_booking` or `me_cancel_booking`
line in the logs for a scheduled run is a defect to look into, because the prompt says a run
books nothing.

- **Cost upstream.** One `book_dates` call plus one `book_times` call per date with free time, per
  run. At the MVP load assumption (under 10,000 bookings a month) this needs no load work.
- **In the logs.** One `mcp_call` line per request, with the tool name and no arguments, like any
  caller (see "Logs"); a run cannot be told from a person's read except by its timing.
- **State.** Nothing about a watch is stored on the server: the ids and the window live in the
  host's task, and pausing or deleting the task stops it.
- **Limits.** The request gate and the edge limits apply as to any caller.
- **Evidence.** The host run record is in `docs/research/cases.md` under "Host runs".

## Admission and shared partner allocation

ME uses developer **2630**, Secret Manager `MARKETPLACE_PARTNER_TOKEN`.
Marketplace confirmations in the platform share this token's relevant quota.
Pro uses a different token (`ALTEGIO_API_TOKEN`); its traffic is not automatically
part of the ME partner allocation.

Client callers (a signed-in client, ADR 0005) share that allocation. Their upstream
calls, the signed-in routes (`GET /user/companies/yplaces`, `GET /user/records`,
`GET /booking/user/data` and the writes of the three tools)
and the business routes alike, run on the partner token the proxy sends with the
client, else on 2630, and pass the same request gate. The call log shows
`caller: client` and never the user token. Until the proxy's end-client sign-in
(I8) ships, only local and test runs reach these routes.

The known partner ceilings are 5 starts/second and 200 starts/rolling minute.
Production ME allocates **90 starts/rolling minute and 2 starts/second per
process** (500 ms spacing). A serialized deployment has the serving process and
at most one tagged candidate in its expected topology, so ME reserves 180/minute
and 4/second for their combined starts. The remaining **20/minute and 1/second**
is reserved for marketplace; platform must account for all consumers of 2630
before raising either allocation. The candidate gate makes no upstream calls.
No burst/load test is needed to verify this allocation.

Queues remain 40 globally and 8 per client key; max projected wait 10 seconds,
tool deadline 25 seconds, upstream timeout 10 seconds. Cancellation removes queued
work. Production composes `PRODUCTION_GATE_OPTIONS`; development gate defaults
remain 250 ms/180 for existing test scenarios. Live tests are capped at 1.35
upstream calls/second and require prior coordination with marketplace maintainers.

Admission limits remain per process, ahead of the partner-token check: global inflight 60, per-IP inflight 6,
IP burst 40/refill 3/sec, shared AI egress pool burst 200/refill 20/sec, tracked
keys 10,000. Only a verified signed client address is trusted; IPv6 buckets use
/64; neither raw addresses nor tool arguments/results are logged. These are
admission controls, not the partner API quota.

Cloud Run service max is 1, revision max is 1, service min is 1 and revision min
is 0. The service minimum keeps serving capacity warm without retaining every
failed candidate at a revision minimum. Tagged candidates can start separately.
Cloud Run can temporarily exceed configured maxima (for example maintenance),
so these settings and per-process gates **do not prove a hard distributed quota**.
Rollout is serialized, failed candidates lose only their own tag, and scaling,
manual tagged probes or extra token consumers must not be added without reviewing
this contract. Unexpected extra instances require investigation; upstream 429
still pauses the process and admission fails busy. A hard quota across arbitrary
replicas would require coordination outside these local gates; none is claimed.

## Logs

Every `mcp_call` has service, version, commit, request_id (also returned as `x-request-id`): the verified signed platform UUID
from `x-mcp-auth-request-id`, or a generated UUID for unsigned/invalid headers, route `/mcp`, closed rpc_method/tool, http_status, outcome,
error_type, latency_ms and nullable limited_by/upstream_kind. Pino emits Cloud
Logging severity/message. Proxy signatures, credentials, tool arguments/results
and raw anonymous IPs are absent. Auth-refusal records are throttled; `suppressed`
counts dropped refusals. Do not derive exact auth-failure counts from line counts.

## Ordered releases and recovery

Increment root `release.json.sequence` for every production/runtime or release
script change, including rollback/revert PRs. CI requires an increase over the PR
base. Before merge, compare against current main and resolve any sequence conflict;
releases with the same number but different commits fail closed. Documentation-only
merges need no deployment. The existing trigger ignores `scripts/**`, so release
script changes must include this root sequence file to trigger a build.

Cloud Build builds and verifies the image, pushes the commit tag and invokes
`scripts/release.py` under the existing dedicated build account. Cloud Run v2
`etag` compare-and-swap acquires annotation `altegio.io/release-owner` and serializes
the entire deploy/smoke/promote/cleanup section. Reconciliation is polled through
service GET (generation/observedGeneration and desired fields), because the
service-scoped build account cannot read regional operation resources. A lower completed release number
cannot deploy or shift traffic. Build order/latest-created revision is irrelevant.
The tag and revision suffix include the unique build ID, not a reusable short SHA.

Promotion writes explicit candidate traffic and release sequence/commit in one
atomic update. Candidate failure preserves good traffic. Post-promotion liveness
failure restores the prior explicit traffic while retaining the advanced sequence,
so delayed old builds cannot overwrite rollback. Cleanup removes only the owning
build's tag and lock, preserving other tags. The normal rollback is a new revert
PR with a higher sequence through the same checks and trigger.

The lock never expires or steals ownership automatically. A killed build or
unknown asynchronous operation retains it; contenders stop after a bounded wait.
Recovery: inspect the owner build in `europe-west1` and any Cloud Run operation;
confirm the build is terminal and the service is not reconciling. An operator may
then remove only that owner's candidate tag and annotation using a fresh v2 etag
patch, preserving all traffic and other annotations. Do not clear all tags, reset
release sequence, or unlock while an operation/build could still mutate the service.
Manual emergency traffic changes still require the owner's explicit approval
under the hosting runbook; ordinary forward rollback remains the delivery path.

API reference: [Cloud Run Service etag](https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services).

## Weekly summary in Slack

Every Monday at 10:00 Europe/Berlin a Claude Code cloud routine posts one message to
`#dev-me-mcp` with the previous calendar week (Monday 00:00 to Sunday 24:00, Europe/Berlin):
sign-ins by assistant, tool calls by tool, bookings by salon and opt-outs. The routine is
"Altegio.me MCP — weekly summary to #dev-me-mcp"
(https://claude.ai/code/routines/trig_01CQJj4tHyPXLcXgiyVGGw3y, created 2026-11-04) and runs
under the owner's claude.ai account; its prompt holds the queries, it checks out nothing from
this repository and changes nothing anywhere. Changing the report means editing that prompt.

Sources, all read-only:

- **Sign-ins by assistant.** The proxy's audit events `altegio_phone_login_ok` and
  `altegio_login_ok` with `resource` `https://mcp.alteg.io/me`, in Cloud Logging of
  `altegio-mcp` (Cloud Run service `mcp-proxy`, the customer stack), read through the
  platform's `gcp-logs` MCP (`https://mcp.altegio.dev/gcp-logs/mcp`, staff Google sign-in).
  Every `client_id` seen on `/me` is a dynamically registered client whose registration event
  carries no name, so the assistant is read from the proxy's `request` lines of the same
  `client_id`: `mcp_client` (the client's `clientInfo`: `Anthropic` is claude.ai, `claude-code`,
  `cursor-vscode`, `openai-mcp` is ChatGPT, `codex-mcp-client`) and `user_agent`
  (`Claude-User`, `Cursor`, `openai-mcp`, `codex-mcp-client`; `altegio-monitoring` is the
  platform's canary and is not a sign-in). Unique users are distinct `sub` values, counted and
  never shown.
- **Tool calls by tool.** This server's `mcp_call` lines (see "Logs") with `rpc_method`
  `tools/call` and `caller` `client`, one filter per tool, `outcome` for the errors and
  `mcp_client` for the assistant, through the same MCP. Partner callers are left out of the
  per-tool count because the platform's canary calls `business_get` with a partner token every
  few minutes (about 2,000 lines a week on 2026-11-04); partner calls to the other tools are
  one number. `query_logs` returns at most 200 entries per call and shows only `message` for
  a line that has one, so a count is the number of entries a filter returns; a window at the
  cap is split by day, then by six hours, and a count still at the cap is written as `≥`.
- **Bookings by salon.** `salon.tt_records` with `partner_id = 5279`, the `partner_systems` id
  of developer account 2630 that every `me_book` write carries, grouped by `salon_id`, with
  `deleted` as later cancellations; MySQL time is UTC+3. A booking made in the widget after a
  `book_check` hand-off carries no partner id and cannot be attributed. BI MySQL replica through
  the `bi-data` MCP.
- **Opt-outs.** `salon.marketplace_application_log` for application 2642 with `status_to`
  `uninstalled`, by `source` (`marketplace` is the location's own switch-off,
  `product_license` and `automatic_expiration` follow the licence), plus
  `marketplace_application_salon_links` for the current number of locations. The Hub's
  `get_statistics` answered 400 on 2026-11-04 and is not used.

The message carries counts and business names only: no phones, e-mails, user ids, `sub`
values or tool arguments. The `gcp-logs` connector was not yet attached to the routine on
2026-11-04; until it is, the message says that the sign-in and tool-call sections are skipped.
