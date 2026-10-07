# Load test results (OPS-07)

What this records: whether the service keeps its traffic to the Altegio API inside the standard
partner limits (5 requests a second and 200 a minute, assumption A1) at the expected peak, and
sheds traffic above its capacity itself instead of passing it on (D-03, plan 03-12). The numbers
come from three tiers: a deterministic simulation in CI, a run of the real container against a
mock upstream that measures its own start rate, and a bounded live run (tier 3, not run; see
below). Since ADR 0004 (2026-10-06, D3) every upstream call carries the caller's own partner
token, so the per-partner budget is each partner's; the limit all callers share is the per-address
one on our egress, and that is what the process-wide request gate keeps.

The mock upstream timestamps every request it receives, in milliseconds, and counts starts over
closed sliding intervals of 1,000 ms and 60,000 ms. A burst that straddles a second boundary is
counted, and the count does not depend on the gate's own accounting. It answers 429 itself when
a start would exceed 5 in 1,000 ms or 200 in 60,000 ms, so a gate that lets too much through
would show up twice, in the maxima and in the 429 count. It also measures the production
allocation from its own start times: the smallest gap (500 ms spacing) and the most starts in any
half-open 1,000 ms (2) and 60,000 ms (90) window.

Reproduce:

```
npm run check                                  # tier 1 runs as src/loadtest/__tests__/peak.test.ts
npm run loadtest -- --scenario=sim             # tier 1 as a report with the PASS/BELOW/FAIL verdict
docker build -t altegio-me-mcp:loadtest .
npm run loadtest -- --scenario=peak     --start-container=altegio-me-mcp:loadtest --duration-sec=600
npm run loadtest -- --scenario=edge     --start-container=altegio-me-mcp:loadtest
npm run loadtest -- --scenario=deadline --start-container=altegio-me-mcp:loadtest
```

Each run writes `results.json` and `container.log` to `loadtest-output/<timestamp>/`, which is
git-ignored. Nothing in tiers 1 and 2 leaves this machine: the container gets a random proxy key
and a canary partner token, and its Altegio API base points at the mock. The verdict is PASS
(every check passed), BELOW (the safety checks passed but fewer than 80% of tool calls were
answered at 1x) or FAIL (a safety check failed).

## Peak arithmetic

Source: `src/loadtest/profile.ts`. The expected peak follows the owner's MVP assumption of
2026-10-07: at most 10,000 bookings a month for the first weeks to months after launch, at about
10 tool calls each (the 2026-10-06 connector run reached the widget link in 6). Capacity is
revisited only if growth exceeds the assumption.

| Step | Value | Basis |
|------|-------|-------|
| Bookings a month | 10,000 | owner MVP assumption, 2026-10-07 |
| Tool calls per booking | 10 | assumption; the connector run took 6 |
| Tool calls a month | 100,000 | 10,000 x 10, the README "Expected" cost column |
| Seconds in a month | 2,592,000 | 30 days |
| Average tool calls a second | 0.039 | 100,000 / 2,592,000 |
| Peak-hour factor | 5 | assumption A2, nothing measured behind it |
| Peak tool calls a second | 0.19 | 0.039 x 5 |
| Tool mix | book_check 17%, business_get 15%, services 20%, team members 15%, dates 17%, time slots 16% | assumption, revisit with real logs |
| Upstream calls per tool call | 1.51 | book_check at 4 (check, card, services, named team member), every other tool at 1 |
| Peak upstream calls a second | 0.29 | 0.19 x 1.51 |
| Gate ceiling | 1.5 a second (90 a minute), 500 ms spacing | `PRODUCTION_GATE_OPTIONS`, the gate `src/server.ts` composes |
| Peak against the ceiling | 19% | 0.29 / 1.5 |
| Saturation | about 515,000 tool calls a month | the monthly volume whose 5x peak hour fills the gate |

The gate has about five times the MVP peak in hand. The earlier profile, the README's peak
column of about 1,000,000 tool calls a month (D-03), sits at 1.94 times the ceiling; it is
exactly the 10x step below, so its numbers stay on record as the measured headroom.

## Tier 1: simulation

Date: 2026-10-07. Commit: a4ccabb. Command: `npm run loadtest -- --scenario=sim` (fixed seed 1,
ten simulated minutes per step; the same steps run in CI as `peak.test.ts`).

The production tools, `BookingClient`, `BookingHttp` and `RequestGate` with the production
options run on a discrete-event clock against an in-process mock with 120 ms of simulated latency
per call. Arrivals are Poisson, the tool is drawn from the mix, and the caller is one of 33
addresses (30 in the claude.ai pool, which is uncapped at the gate, and 3 single callers with the
per-key cap of 8). No network and no real time are involved; tier 1 applies no measurement
tolerance.

Max upstream starts in any 1 s: 3 (limit 5)
Max upstream starts in any 60 s: 91 (limit 200)
Upstream 429 responses: 0

The maxima are the largest of the three steps. The production allocation held at every step:
smallest gap 500 ms, at most 2 starts in any half-open second and 90 in any half-open minute.

| Offered load | Tool calls | Answered | Busy (turned away by the gate) | Upstream starts | Max in 1 s | Max in 60 s | Upstream 429 |
|--------------|-----------:|---------:|-------------------------------:|----------------:|-----------:|------------:|-------------:|
| 1x MVP peak | 113 | 113 (100.0%) | 0 | 174 | 3 | 37 | 0 |
| 2x | 222 | 222 (100.0%) | 0 | 340 | 3 | 57 | 0 |
| 10x (the earlier 1M profile) | 1,151 | 606 (52.6%) | 545 | 919 | 3 | 91 | 0 |

Verdict: PASS, 25 checks. Capacity sweep (quarter steps, seed 1): 6.25x the MVP peak, about
625,000 tool calls a month at the assumed 5x peak hour, is the largest step that answers more than
80% (81.0%); 6.5x answers 78.7%. At 10x the gate's queue cap of 40 turns the excess away as the
in-band "booking service is busy" tool error and the upstream start count stays at the allocation;
no call failed any other way. The 10x row is the 03-20 result for the earlier profile on the
production gate, unchanged.

## Tier 2: local container

Date: 2026-10-07 (peak run 04:15 to 04:27 UTC). Commit: 5e71c2d. Image: `altegio-me-mcp:loadtest`,
image id 146c40082dab, built from the repository Dockerfile (Node 22 Alpine, digest pinned).
Container settings: `NODE_ENV=test`, `PROXY_AUTH=required`, `CALLER_AUTH=optional` (the load
generator sends no partner token, as `scripts/smoke.sh`; the caller check has its own tests and
does not touch the gate), a random 64-hex proxy key, a canary partner token, `ALTEGIO_API_BASE`
on the mock through `host.docker.internal`. Docker 29.5 under Colima. Every request is signed the
way the platform proxy signs it: `x-mcp-auth-client-ip` inside the signature, and
`X-Forwarded-For: <junk>, <client>, <egress>`. Tier 2 uses a fixed arrival tolerance of 50 ms on
the allocation checks, set before any run.

Peak run: 1x for 600 s, then a 2x step for 60 s and a 10x step for 20 s, open-loop Poisson
arrivals from 30 addresses inside 160.79.104.0/21 and 3 single addresses.

Max upstream starts in any 1 s: 3 (limit 5)
Max upstream starts in any 60 s: 84 (limit 200)
Upstream 429 responses: 0

Measured by the mock over the whole run (305 upstream starts). Verdict: PASS, 17 checks.

| Step | Tool calls | Answered | Busy | HTTP statuses | Latency p50 / p95 / max |
|------|-----------:|---------:|-----:|---------------|-------------------------|
| 1x, 600 s | 126 | 126 | 0 | 200 x 126 | 68 ms / 1.6 s / 1.9 s |
| 2x, 60 s | 26 | 26 | 0 | 200 x 26 | 527 ms / 2.4 s / 2.5 s |
| 10x, 20 s | 38 | 35 | 3 | 200 x 38 | 4.6 s / 14.3 s / 14.5 s |

- The allocation held over the whole run: smallest gap between upstream starts 470 ms (allocation
  500 ms, tolerance 50 ms), at most 2 starts in any half-open 950 ms window and 84 in any half-open
  59,950 ms window (allocation 90). The closed-interval maxima were 3 in 1 s and 84 in 60 s.
- No HTTP 429 for the 30 pool addresses at any step, and no other HTTP status than 200.
- No tool error other than the in-band "busy" one, and only at the 10x step: 3 of 38 calls in a
  20 s burst, when the gate's queue of 40 was briefly full of book_check's four-call chains.
- The container log counts 190 `mcp_call` lines: 187 ok and 3 `limited_by: gate`.
- Latency at 1x is the mock's own (p50 68 ms); at 2x the median call waits about half a second
  in the gate and at 10x about 4.6 s, the same waiting-time shape the 03-12 run showed one
  profile step higher.

A first attempt the same day (commit a4ccabb) answered 0 of 126 calls: since ADR 0004 the image
defaults to `CALLER_AUTH=required`, and the harness started it without the setting, so every
request got 401 `partner_token_required` and the mock saw no start. The harness now sets
`CALLER_AUTH=optional` (commit 5e71c2d); the numbers above are from the run after that fix.

Edge scenario (8 checks, all passed, re-run 2026-10-07 04:27 UTC at commit 5e71c2d, unchanged since 2026-10-04):

- An unsigned request and a request signed with another key both get 401.
- 60 rapid POSTs from one address: the first 40 are served (the bucket holds 40), requests 41 to
  60 get 429 with a whole-second `Retry-After` and the JSON-RPC body with code -32000.
- 60 POSTs from 30 pool addresses: all 60 served, no 429.
- A forged leftmost `X-Forwarded-For` entry does not change the key: with a signed client
  address, and with no signed address (the entry counted from the right), 20 of 60 requests
  still got 429.
- An address that sent nothing before is served, so the limit is per address, not global.

Deadline scenario (4 checks, all passed, re-run 2026-10-07 04:27 UTC at commit 5e71c2d, unchanged since 2026-10-04): the mock stalls `book_times` for 30 s.

- The tool call came back with an in-band error after 10.08 s, well inside 26 s. The per-fetch
  timeout of 10 s fired first; the 25 s tool deadline is the backstop behind it and is covered by
  the 03-06 tests, so this run does not exercise the deadline itself.
- The stalled call was started once and was not retried.
- A client that hung up after 1 s: the mock recorded the request as aborted and no later start
  followed it (2 starts in total after 3 more seconds).

## Observations

- At the MVP peak the gate is idle most of the time: 0.29 upstream calls a second against an
  allocation of 2 a second and 90 a minute. Every call is answered and the only latency is the
  upstream's own. The gate starts to matter at about 5x the MVP peak and sheds above about 6x.
- The earlier profile (about 1,000,000 tool calls a month, now the 10x step) is what the gate
  cannot carry: on the production gate it answers 52.6% in tier 1 and answered 50.8% in the
  tier 2 run of 2026-10-07 at commit 46b7263 (03-20), with 0 upstream 429. Headroom for that
  volume needs a dedicated partner type (B3) or a second allocation, and is not pursued at MVP
  scale.
- The deploy pins one instance (`--max-instances=1`), so one gate covers all traffic. A second
  instance would double the effective upstream rate; the gate would then no longer be the single
  guard.
- At 10x the gate turns calls away at its queue cap of 40 before the edge in-flight cap of 60 is
  reached, so no edge 429 appears in that step. The edge numbers from plan 03-09 were left as
  they are: the runs gave no reason to change them.

## Tier 3: live, bounded

Status: deferred 2026-10-07 (owner decision; supersedes the deferral of 2026-10-06)

The live run is not needed to close this phase and is deferred. Reasons:

- The platform contract in `docs/runbooks/operations.md` states that no burst or load test is
  needed to verify the allocation, and tiers 1 and 2 prove the gate arithmetic against the mock
  upstream.
- The MVP assumption (at most 10,000 bookings a month) puts the peak hour at about a fifth of the
  gate ceiling, so a live run would spend a partner's budget to prove headroom the MVP does not
  need.
- The dedicated partner type (B3) is not requested and, since ADR 0004 gives each partner its own
  budget, is not what the live run would test.

Trigger: run it when the call log shows a meaningful share of `limited_by: gate` at the public
route, or when B3 delivers a dedicated partner type, after announcing it to the platform owner in
#dev-ai-coding.

Built and ready for that run:
`npm run loadtest -- --scenario=live --target=https://mcp.alteg.io/me --confirm-announced`. It
reads through the deployed service with the five read-only tools (never `book_check`), at
location 726120, with hard bounds: the default is 1 tool call a second for 120 s, the cap 1.35
calls a second and 180 s, a 30 s request timeout, no catch-up pacing, and it stops at the first
busy or not-accepted tool error, or the first HTTP 401, 429 or 5xx. Two things must be settled
before the first live run: since 2026-10-06 the public route requires a partner token
(`CALLER_AUTH=required`), and the script does not send one yet; and `business_list_services`
makes two upstream calls, so a 90% margin on the gate's 1.5 upstream calls a second is `--rate
1.125`, not the 1.35 cap (03-21).

## Known deviation

Production runs on each caller's own partner token since ADR 0004 (2026-10-06); the partner token
of developer account 2630 "Altegio AI" stays mounted for `CALLER_AUTH=optional` and local runs.
The dedicated-partner-type clause of OPS-07 is not met (D-03): that partner type (B3) is not
requested and is not in place. The owner decided on 2026-10-03 to start with the current limits
and to ask the backend team for a dedicated partner type or higher limits when the limits are
actually hit, and on 2026-10-07 that the MVP sees at most 10,000 bookings a month, at which the
production gate (2 starts a second, 90 a minute) carries the peak hour with about five times
headroom. Phase 3 closes OPS-07 by that owner override (`03-VERIFICATION.md`).
