# ME operational contract

ME is stateless and admits callers by their own Altegio partner token (ADR 0004;
`CALLER_AUTH=required` in production since 2026-10-06); Pro is
authenticated/stateful. All eight ME tools remain user reads (six for a known
business, plus `me_list_places` and `me_list_bookings` for a signed-in client);
`book_check` hands confirmation to the booking widget. No OAuth page, booking
write, catalog search or customer VM autoheal is introduced here.

## Signals and publication gate

- Liveness: backend `GET /health`, HTTP 200, `status=ok`, `service=altegio-me-mcp`,
  package `version` and deployed `commit`. It performs no upstream API call.
- Protocol: signed HTTPS `initialize` with protocol `2025-11-25`, then
  `tools/list`; valid JSON-RPC results, precisely the eight documented tools
  (six known-business tools, `me_list_places` and `me_list_bookings`),
  object input schemas and no `mcp-session-id`. Direct unsigned `/mcp` remains 401.
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

## Admission and shared partner allocation

ME uses developer **2630**, Secret Manager `MARKETPLACE_PARTNER_TOKEN`.
Marketplace confirmations in the platform share this token's relevant quota.
Pro uses a different token (`ALTEGIO_API_TOKEN`); its traffic is not automatically
part of the ME partner allocation.

Client callers (a signed-in client, ADR 0005) share that allocation. Their upstream
calls, the two signed-in routes (`GET /user/companies/yplaces` and `GET /user/records`)
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
