# Load test results (OPS-07)

What this records: whether the service keeps its traffic to the Altegio API inside the standard
partner limits (5 requests a second and 200 a minute, assumption A1) at the expected peak, and
sheds traffic above its capacity itself instead of passing it on (D-03, plan 03-12). The numbers
come from three tiers: a deterministic simulation in CI, a run of the real container against a
mock upstream that measures its own start rate, and a bounded live run that belongs to plan
03-16. The partner token is shared with Altegio.Pro MCP (D-02), so most of the proof is local.

The mock upstream timestamps every request it receives, in milliseconds, and counts starts over
closed sliding intervals of 1,000 ms and 60,000 ms. A burst that straddles a second boundary is
counted, and the count does not depend on the gate's own accounting. It answers 429 itself when
a start would exceed 5 in 1,000 ms or 200 in 60,000 ms, so a gate that lets too much through
would show up twice, in the maxima and in the 429 count.

Reproduce:

```
npm run check                                  # tier 1 runs as src/loadtest/__tests__/peak.test.ts
docker build -t altegio-me-mcp:loadtest .
npm run loadtest -- --scenario=peak     --start-container=altegio-me-mcp:loadtest
npm run loadtest -- --scenario=edge     --start-container=altegio-me-mcp:loadtest
npm run loadtest -- --scenario=deadline --start-container=altegio-me-mcp:loadtest
```

Each run writes `results.json` and `container.log` to `loadtest-output/<timestamp>/`, which is
git-ignored. Nothing in tiers 1 and 2 leaves this machine: the container gets a random proxy key
and a canary partner token, and its Altegio API base points at the mock.

## Peak arithmetic

Source: `src/loadtest/profile.ts`. Every figure follows from the README estimate of about
1,000,000 tool calls a month.

| Step | Value | Basis |
|------|-------|-------|
| Seconds in a month | 2,592,000 | 30 days |
| Average tool calls a second | 0.386 | 1,000,000 / 2,592,000 |
| Peak-hour factor | 5 | assumption A2, nothing measured behind it |
| Peak tool calls a second | 1.93 | 0.386 x 5 |
| Tool mix | book_check 17%, business_get 15%, services 20%, team members 15%, dates 17%, time slots 16% | assumption, revisit with real logs |
| Upstream calls per tool call | 1.51 | book_check at 4 (check, card, services, named team member), every other tool at 1 |
| Peak upstream calls a second | 2.91 | 1.93 x 1.51 |
| Gate ceiling | 3.0 a second (180 a minute) | `DEFAULT_GATE_OPTIONS.perMinute` |
| Peak against the ceiling | 97% | 2.91 / 3.0 |

The expected peak sits just under the ceiling of one gate. That is the reason the gate, not the
partner limiter, has to be the thing that says no.

## Tier 1: simulation

Date: 2026-10-04. Commit: 7223505. Command: `npx jest src/loadtest` (fixed seed 1, ten
simulated minutes per step, about 0.2 to 0.6 s of real time each).

The production tools, `BookingClient`, `BookingHttp` and `RequestGate` run on a discrete-event
clock against an in-process mock with 120 ms of simulated latency per call. Arrivals are
Poisson, the tool is drawn from the mix, and the caller is one of 33 addresses (30 in the
claude.ai pool, which is uncapped at the gate, and 3 single callers with the per-key cap of 8).
No network and no real time are involved.

Max upstream starts in any 1 s: 5 (limit 5)
Max upstream starts in any 60 s: 181 (limit 200)
Upstream 429 responses: 0

The maxima are the largest of the three steps; each step reached the same values.

| Offered load | Tool calls | Answered | Busy (turned away by the gate) | Upstream starts | Max in 1 s | Max in 60 s | Upstream 429 |
|--------------|-----------:|---------:|-------------------------------:|----------------:|-----------:|------------:|-------------:|
| 1x peak | 1,151 | 1,102 | 49 | 1,806 | 5 | 181 | 0 |
| 2x peak | 2,305 | 1,202 | 1,103 | 1,849 | 5 | 181 | 0 |
| 10x peak | 11,713 | 1,189 | 10,524 | 1,858 | 5 | 181 | 0 |

Above the peak the answered count stays at the gate's capacity and the excess is returned as the
in-band "booking service is busy" tool error. The upstream start count does not grow with the
offered load. No call failed any other way.

## Tier 2: local container

Date: 2026-10-04 (peak run 13:49 to 13:54 UTC). Commit: d37b970. Image: `altegio-me-mcp:loadtest`,
image id ffa99144c15a, built from the repository Dockerfile (Node 22 Alpine, digest pinned).
Container settings: `NODE_ENV=test`, `PROXY_AUTH=required`, a random 64-hex proxy key, a canary
partner token, `ALTEGIO_API_BASE` on the mock through `host.docker.internal`. Docker 29.5 under
Colima. Every request is signed the way the platform proxy signs it: `x-mcp-auth-client-ip`
inside the signature, and `X-Forwarded-For: <junk>, <client>, <egress>`.

Peak run: 1x for 180 s, then a 2x step for 60 s and a 10x step for 20 s, open-loop Poisson
arrivals from 30 addresses inside 160.79.104.0/21 and 3 single addresses.

Max upstream starts in any 1 s: 5 (limit 5)
Max upstream starts in any 60 s: 181 (limit 200)
Upstream 429 responses: 0

Measured by the mock over the whole run (900 upstream starts). After the 1x step alone the
maxima were 5 and 181 as well.

| Step | Tool calls | Answered | Busy | HTTP statuses | Latency p50 / p95 / max |
|------|-----------:|---------:|-----:|---------------|-------------------------|
| 1x, 180 s | 344 | 333 | 11 | 200 x 344 | 4.6 s / 11.2 s / 16.6 s |
| 2x, 60 s | 211 | 130 | 81 | 200 x 211 | 7.3 s / 18.9 s / 19.9 s |
| 10x, 20 s | 380 | 65 | 315 | 200 x 380 | 3 ms / 10.0 s / 19.9 s |

- No HTTP 429 for the 30 pool addresses at 1x (the pool shares one bucket of 200 with 20 a second
  of refill), and no other HTTP status than 200 at any step.
- No tool error other than the in-band "busy" one at any step.
- The container log counts 935 `mcp_call` lines: 528 ok and 407 `limited_by: gate`.

Edge scenario (8 checks, all passed):

- An unsigned request and a request signed with another key both get 401.
- 60 rapid POSTs from one address: the first 40 are served (the bucket holds 40), requests 41 to
  60 get 429 with a whole-second `Retry-After` and the JSON-RPC body with code -32000.
- 60 POSTs from 30 pool addresses: all 60 served, no 429.
- A forged leftmost `X-Forwarded-For` entry does not change the key: with a signed client
  address, and with no signed address (the entry counted from the right), 20 of 60 requests
  still got 429.
- An address that sent nothing before is served, so the limit is per address, not global.

Deadline scenario (4 checks, all passed): the mock stalls `book_times` for 30 s.

- The tool call came back with an in-band error after 10.06 s, well inside 26 s. The per-fetch
  timeout of 10 s fired first; the 25 s tool deadline is the backstop behind it and is covered by
  the 03-06 tests, so this run does not exercise the deadline itself.
- The stalled call was started once and was not retried.
- A client that hung up after 1 s: the mock recorded the request as aborted and no later start
  followed it (2 starts in total after 3 more seconds).

## Observations

- The expected peak is close to what one gate can carry. At 97% of the ceiling, Poisson bursts
  queue calls: at the 1x step 3 to 4% of tool calls were answered "busy" (11 of 344 here, 49 of
  1,151 in the simulation) and the median call waited about 4.6 s in the gate. The upstream is
  never over its limit; the cost is latency and a few busy answers. This is the quantified
  version of the OPS-06 note that headroom above about 1M tool calls a month needs B3.
- The deploy pins one instance (`--max-instances=1`), so one gate covers all traffic. A second
  instance would double the effective upstream rate; the gate would then no longer be the single
  guard.
- At 10x the gate turns calls away at its queue cap of 40 before the edge in-flight cap of 60 is
  reached, so no edge 429 appeared in that step. The edge numbers from plan 03-09 were left as
  they are: the run gave no reason to change them.
- The mock saw exactly 5 starts in a closed 1,000 ms interval (starts 250 ms apart, the first
  and the fifth 1,000 ms apart). That is at the limit and not over it; if the real limiter counts
  differently the first live run shows it.

## Tier 3: live, bounded

Status: deferred 2026-10-06 (owner decision)

The live run is not needed to close this phase and is deferred. Reasons:

- The platform contract in `docs/runbooks/operations.md` states that no burst or load test is
  needed to verify the allocation, and tiers 1 and 2 already prove the gate arithmetic against the
  mock upstream.
- A live run spends the budget of the partner token of account 2630, which the marketplace
  confirmations share.
- ROADMAP criterion 4 needs the dedicated partner token from B3, so a run on the standard limits
  would not close it anyway.

Trigger: run it when B3 delivers the dedicated partner token, or before directory submission,
whichever comes first, after announcing it to the platform owner in #dev-ai-coding.

Built and ready for that run:
`npm run loadtest -- --scenario=live --target=<service base URL> --confirm-announced`. It reads
through the deployed service with the five read-only tools that make one upstream call each
(never `book_check`), at location 726120. The default is 1 upstream call a second for 120 s; the
script caps the run at 1.35 upstream calls a second (90% of the production gate's 1.5) and 180 s.
It is unsigned because the platform proxy signs. It refuses to start without `--confirm-announced`,
and stops at the first busy or not-accepted tool error, or the first HTTP 401, 429 or 5xx.

## Known deviation

Production runs on the partner token of developer account 2630 "Altegio AI" under the standard
partner limits (D-03). The dedicated-partner-type clause of OPS-07 is not met: that partner type
(B3) is not requested and is not in place. The owner decided to start with the current limits and
to ask the backend team for a dedicated partner type or higher limits when the limits are
actually hit. Until then the guard is our own gate at 4 starts a second and 180 a minute, and the
load test shows that it holds at and above the expected peak. Headroom above about 1M tool calls
a month needs B3.
