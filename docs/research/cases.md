# Added-value cases: research record (CASE-01)

Research date: 2026-10-09 (plan 05-01, decisions D-01 to D-05). Answers, for each of the three cases
the Altegio.me app lacks, whether to build it, what ships first and by which mechanism. The API
answers come from backend code and, for two people side by side, from one live run at the owner's
business (see "Pair probe"). The host answers come from the hosts' own documentation read on
2026-10-09 and are valid until 2026-10-23, because the host features are in research preview. No
token, phone, name, e-mail, record hash or confirmation token is in this document.

Eval tasks for each shipped case are written in Phase 5 and run in Phase 6 (D-05, LIST-06).

## Go/no-go

| Case | Verdict | First scope | Mechanism | Ships in |
| --- | --- | --- | --- | --- |
| Two people side by side | GO-WITH-SCOPE | Two appointments at one start with two different, named team members, both under the signed-in client; nothing about the second person is sent | One `me_book` call with an optional second appointment, one preview, one confirmation, one `POST /book_record` with `appointments[2]` (D-01) | 05-02 |
| Freed-slot monitoring | GO | A host scheduled task checks `business_list_dates` and `business_list_time_slots` for one team member and reports free slots; it never books | Prompt text on the host's scheduled tasks (Claude Cowork, Claude Code routines; ChatGPT unverified); nothing stored on the server; the client books with `me_book` when back (D-03) | 05-03 |
| Slot hold | CONDITIONAL | The reminder variant: a host task asks "keep or cancel?" a day before the business's online cancellation limit; the unattended release waits on I8 and one host run that shows an unattended confirmation | `me_book` now, a one-off host task later; `me_cancel_booking` stays two-step (D-04) | 05-04, last |

## Two people side by side

Verdict GO-WITH-SCOPE, and the probe below confirmed the contract.

### API facts

- **One client, several records.** The create body has one `phone`, `fullname` and `email`; each
  item of `appointments[]` carries only `id`, `services`, `staff_id`, `datetime` and
  `custom_fields`. The answer has one `{id, record_id, record_hash}` per appointment. The backend
  resolves one booking user and one client per request (biz.erp `BookRecordController.php`).
  So two appointments are two records of one client, not two seats and not two people.
- **437 semantics.** `ERROR_CODE_MASTER_HAS_NOT_ENOUGH_TIME` (437) is raised only inside the loop
  over the appointments of one request, when two of them land on the same team member at
  overlapping times (`BookingService.php`). Two different team members at one start do not trigger
  it. The probe confirmed both halves: the pair on two team members passed the check and the
  create; the same team member twice was refused.
- **Team member 0 is a trap.** For "any" the backend picks a random team member per appointment, so
  two "any" entries, or one named and one "any", can resolve to one team member and be refused.
  The scope therefore requires two explicit, different ids (assumption A2, inferred from code,
  not run).
- **No per-appointment name.** For a signed-in user the request `fullname` only fills an empty
  first name. The second person's name goes nowhere, and ADR 0006 keeps the records free of any
  `comment`. Both records carry the signed-in client.
- **`book_check` validates both appointments in one call** and accumulates its errors.
- **The create is atomic.** All appointments are validated before any record is written, so a
  refused second appointment creates nothing. Two sequential `me_book` calls lose this.
- **The widget has no such flow.** It sends one appointment per booking.

### Scope, preview and error mapping (what 05-02 builds)

- `me_book` gets an optional `second_appointment` (services and a team member) at the same start.
  Both team member ids must be above 0 and different. The preview lists both appointments and says
  both bookings are under the client's name. Fallbacks (prepayment, membership, widget inactive)
  are judged per appointment, and any one of them turns the whole call into a `fallback`.
- The first scope excludes back-to-back times, more than two appointments and different start times.
- A refused pair answers 422. The same-team-member refusal arrives **without an error code** (see
  "Pair probe"), so the mapping cannot key on 437 alone; because 05-02 refuses equal ids before
  any call, it only has to report an unexpected 422 for a pair as "the place did not accept both
  times; pick other times or team members". A taken slot (433) keeps its documented code.
- Cancelling is per record; the prompt cancels both records when asked.

### Risks

- The business sees two records under the parent's name and may call the parent. The preview
  sentence tells the client to say who the second one is for.
- A request with more than one appointment is logged by the backend as an info event only.
- Whether the business shows the two records as one visit or two was not checked.

## Freed-slot monitoring

Verdict GO. It ships as prompt text on the host's scheduling, with no server code and no server
state. The report ends in an interactive `me_book` with the client present; there is no unattended
booking.

### Host capabilities (read 2026-10-09; valid until 2026-10-23)

| Host | Scheduling | Connectors in a run | Approval during a run | Source |
| --- | --- | --- | --- | --- |
| Claude Cowork scheduled tasks (paid plans) | hourly, daily, weekly, weekdays, manual; run remotely, even when the computer sleeps | work with the account's connectors | an approval mode chosen at creation, details not documented | support.claude.com/en/articles/13854387 |
| Claude Code routines (cloud) | presets and cron, minimum 1 hour, one-off runs | the account's connectors, all included by default | no approval prompts; the fired prompt "is not live user input and can't act as approval or consent" | code.claude.com/docs/en/routines |
| Claude Code Desktop local tasks | down to 1 minute, one-off; only while the app is open and the machine awake | config files and connectors | per-task permission mode; stalls until approved | code.claude.com/docs/en/desktop-scheduled-tasks |
| ChatGPT scheduled tasks | one-time or recurring, "monitor for changes" | supported apps; custom MCP apps in tasks not verified | not verified | help.openai.com/en/articles/10291617 (search snippets only; the page returned 403) |

MCP 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28/changelog) is stateless.
`subscriptions/listen` carries list-changed notifications only to a client that holds the stream
open, tasks moved to an extension that the client polls, and server-initiated requests were
replaced by `input_required` results. Nothing lets a server wake a host or message a user.

### Rejected: a server-side watcher

It would need Cloud Scheduler, a keyed store (location, services, team member, window, a client
reference) and a notification channel we do not have. SMS, e-mail or Telegram all mean storing
contacts or the user token, which breaks the stateless and no-personal-data decisions. The upstream
cost is the same either way (one `book_dates` call plus k `book_times` calls per check, about
100 to 200 calls a day at 50 watchers). Host scheduling wins on state, privacy and infrastructure.

### Run shape

1. In the chat, with the client present: `me_list_places` supplies the usual team member and
   service, the client gives the window (dates within 62 days, time of day).
2. The assistant helps the client create a host task with the ids and the window in the task
   prompt, daily or hourly at most.
3. Each run calls `business_list_dates`, then `business_list_time_slots` per date, filters to the
   window and reports new free times or "nothing yet". Both are partner-tier tools, so no sign-in
   is needed. It books nothing.
4. The client picks a time later, and the normal two-step `me_book` runs. On claude.ai that needs
   I8; until then the fallback is `book_check` and the pre-filled link.
5. The client stops it by pausing or deleting the task.

### Risks

- Paid plans are needed for Cowork and routines; Desktop tasks skip runs while the machine sleeps.
- The slot may be gone when the client reads the report; the `me_book` preview checks again.
- Model drift into auto-booking: the prompt forbids it, and an unattended `me_book` would stall on
  consent anyway.
- ChatGPT custom MCP apps inside tasks are unverified; the docs must not claim them.

## Host runs

Two runs on 2026-10-09: the pair tool run through the real app, which passed, and the host
scheduled task, which could not reach the server. Neither record holds a token, phone, name or
e-mail; the owner's words and a git-ignored evidence file carry the detail.

### Pair tool run (plan 05-02 code, run at the 05-03 checkpoint)

Run: 2026-10-09 15:51 UTC (22:51 UTC+7)
Commit: 863fb4d
Status: passed

- **Command (the owner's shell, the executor never opens the env file):**
  `ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_PAIR=1 node --env-file=.env ./node_modules/jest/bin/jest.js --testPathPatterns=me-pair.live --runInBand`
  (`src/__tests__/me-pair.live.test.ts`, branch `phase-05-cases`). The real app in process,
  `CALLER_AUTH=optional`, the production request gate and the direct user-token header, against
  the real Altegio API, from the owner's machine, not from Cloud Run.
- **Where:** location 726120, service 13884511, team members 3110938 and 3110937, slot
  2026-10-11T12:00:00+02:00.
- **Steps, all as expected:** `me_list_bookings`, `business_list_services`,
  `business_list_team_members`, `business_list_dates` for both team members,
  `business_list_time_slots` for both on 2026-10-11, `me_book` preview (`preview`), `me_book`
  with the token (`booked`, bookings 676436066 and 676436067), `me_list_bookings`,
  `me_cancel_booking` for each (preview, then `cancelled`), `me_list_bookings`.
- **Counts:** 26 upstream calls, no skipped step, no failure, no fallback reason, no refusal.
- **Cleanup:** none needed; both bookings were seen cancelled in the closing read, so no
  `PAIR_CLEANUP` line was printed.
- **Evidence:** the owner's reply and `loadtest-output/me-pair-run.json` (git-ignored) agree; the
  file holds ids, statuses, counts and booleans only.
- **What it shows:** `me_book` with `second_appointment` books two appointments under the client's
  name in one preview and one confirmation, and each is cancelled on its own, through the real
  app. It closes the open live run of 05-02.
- **What it does not show:** the Cloud Run egress and its anti-fraud behaviour (WRITE-07, B3),
  other businesses and their settings, two "any" entries (A2), and how the business displays the
  two records.

### Host scheduled task (Claude Desktop, Cowork)

Host: Claude Desktop, Cowork scheduled task "Мастер свободные слоты", created and run once with
"Run now" on 2026-10-09 (start time not noted by the owner)
Plan and schedule: the owner's paid plan (not recorded); the host asked for the missing values and
settled on one run now over a rolling 7 days, any of the 7 team members
Approval mode: none asked
Status: blocked, no tool of this server was reached
Write tools called: none
Tools seen in the logs for the window: logs not read (the platform's log read needs a new gcloud
sign-in that a non-interactive run cannot give); the owner's description stands
Report matched a direct read: not applicable, the run reported no times

- **What the owner saw.** The task ran, parsed the watch text and asked for what the text left open
  (which team member, the date range, the frequency), then reported that the booking connector's
  tools were not available in that session.
- **Root cause.** Since ADR 0004 (2026-10-06) `/me` needs a partner token, and claude.ai and Claude
  Desktop custom connectors cannot send headers, so the connector added on 2026-10-06 can no longer
  reach the server. The host run waits for the proxy's client OAuth (altegio-mcp-platform PR #255,
  open item I8).
- **What worked.** The scheduling mechanics: the task was created, run on demand, read the prompt
  text and asked for the missing ids and window. Claude Code with `claude mcp add --header` would
  reach the server today; it was not used.
- **What it does not show:** a run that reads free times on a host, how a daily or hourly
  repeat behaves, the approval mode of an unattended run (A4), booking from a report (needs I8 on
  claude.ai), and ChatGPT (not tried, A5).

Retest when: the proxy's client OAuth (I8, PR #255) lets the claude.ai or Claude Desktop connector
reach `/me`, or in Claude Code with a routine over `claude mcp add --header`; then one "Run now" of
`watch_for_a_free_slot` text with ids, a window and the schedule, and a check that the logs show
`business_list_dates` and `business_list_time_slots` and no `me_book`, `me_reschedule_booking` or
`me_cancel_booking`.

## Slot hold

Verdict CONDITIONAL, and last. Mechanically it is `me_book` now plus a one-off host task that
releases the hold through `me_cancel_booking`, unless the client deleted the task.

- **Cancellation rules.** The card carries `allow_delete_record` and
  `allow_delete_record_delay_step`; the preview already renders them ("not allowed" or "allowed
  until {duration} before the start"). A signed-in client needs only the record id to cancel.
  726120 allows it up to 2 hours before the start.
- **Deadline rule.** The reminder or release time is the earlier of the client's deadline and the
  latest online cancellation time minus a margin; the reminder variant fires a day before the
  latest online cancellation time. Where online cancellation is not allowed, or its window has
  passed, there is no hold.
- **Token lifetime.** A confirmation token lives 10 minutes, so nothing can be pre-issued at
  setup; the run would have to issue and redeem it.
- **Consent in unattended runs.** Claude routines state that the fired prompt cannot act as
  approval or consent. The model may stop at the preview. This is the main uncertainty (A4).
- **Standing.** A cancelled record shows `deleted` and attendance 0 in the 04.1 recording; a
  no-show is marked by staff on past records. A hold released in time therefore leaves no no-show.
  What the business sees of a client-cancelled record is not known (A6).
- **Variants.** The reminder variant ("keep or cancel?" a day before the limit, the client cancels
  in the chat) ships first. The auto-release ships only after I8 and one host run showing an
  unattended confirmation (the gate in D-04); otherwise it moves to the backlog.
- **Risks.** An unattended stall keeps the booking (fails safe for the client, holds the business's
  slot); repeated holds are a fairness and blacklist risk, so one hold per place at a time;
  prepaid services go to the widget.

## Anti-fraud

- **Code finding.** The backend's fraud check returns valid early for a partner that is not of
  the widget type, after the IP-ban check alone (`BookingFraudProtectionService.php`). The
  limiters (IP 100 per hour, IP and business 10 per 5 minutes, phone 5 per 5 minutes) are called
  only on the confirmation path of the new widget.
- **For partner 2630**, if it is not a widget-type partner (A3, assumed), the remaining risk is an
  IP ban of the Cloud Run egress answering a fake 201, which `me_book` already reports as
  `not_confirmed`.
- **Status.** WRITE-07 and B3 stay open until a run from the Cloud Run egress. The pair probe ran
  from the owner's network and did not close them: it saw no security header and no 412.

## Assumptions

| # | Claim | Status after the probe |
| --- | --- | --- |
| A1 | No business setting refuses one client two simultaneous online records | Settled at 726120: the create answered 201 with two record ids and both records were listed. Other businesses are not covered |
| A2 | Two "any" (0) entries can resolve to one team member and be refused | Open, inferred from code, not run; the scope refuses 0 for a pair either way |
| A3 | Partner of account 2630 is not a widget-type partner | Open; the probe saw no 412, from the owner's network only |
| A4 | A Cowork scheduled task can call a custom connector's write tools unattended | Open; the 05-03 host run was blocked before any tool call (see Host runs), so it shows nothing about it; retest after I8 |
| A5 | ChatGPT scheduled tasks can call custom MCP apps | Open; the docs must not claim it |
| A6 | A client-cancelled record leaves no visible penalty beyond history | Open; both records showed `deleted` after the cancel, the business's view was not checked |

## Pair probe

Run: 2026-10-09 12:21 UTC (19:21 UTC+7)
Commit: f8a59d9
Status: passed (10 of 10 tests)

- **Command (the owner's shell, the executor never opens the env file):**
  `ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_PAIR=1 node --env-file=.env ./node_modules/jest/bin/jest.js --testPathPatterns=pair-booking.live --runInBand`
  (`src/booking/__tests__/pair-booking.live.test.ts`, branch `phase-05-cases`). Direct calls with
  `Authorization: Bearer <partner>, User <user>` (the two checks with the partner token alone),
  from the owner's machine, not from Cloud Run.
- **Where:** location 726120 (the owner's own business), service 13884511, team members 3110938
  and 3110937, one slot 2026-10-11T12:00:00+02:00, two days ahead.
- **What was sent:** one client (profile phone as `+digits`, profile name, profile e-mail when
  present) and two appointments, `id` 1 and 2, on the two team members at the slot. No team member
  0, no `comment`, no second name, phone or custom fields.
- **Evidence:** the owner's reply and `loadtest-output/pair-booking-run.json` (git-ignored) agree.
  Only ids, statuses, counts and booleans were recorded; the run file holds no token, phone, name,
  e-mail or hash (the create answer's hashes are removed).

| Step | Call | Status |
| --- | --- | --- |
| 1 | `GET /booking/user/data` | 200 |
| 2 | `GET /book_staff/726120` | 200, two team members bookable for the service |
| 3 | `GET /book_dates/726120` (A, B), `GET /book_times/726120/{id}/{date}` (A, B) | 200, 200, 200, 200 |
| 4 | `POST /book_check/726120`, two appointments on two team members | **201** |
| 5 | `POST /book_check/726120`, both appointments on the same team member | **422**, no error code |
| 6 | `POST /book_record/726120`, `appointments[2]` | **201**, two positive record ids (676381084, 676381085) |
| 7 | `GET /user/records` | 200, both present, none deleted, staff ids A and B, one datetime, `clients_count` 1 and 1 |
| 8 | `DELETE /user/records/{id}/0` for each | **204**, **204** |
| 9 | `GET /user/records` | 200, both `deleted` |

- **The same-team-member refusal carries no error code.** The 422 answer had `meta.message`
  "Failed to register: the team member does not have enough time to perform the selected
  services." and an empty `meta.errors`, so the client's error codes are empty for it. The
  documented shape (code 437 in `meta.errors`) did not appear. Both shapes are in the contract
  fixtures (`pair_same_member_437` as observed, `pair_same_member_coded_437` as documented).
- **Calls:** 13 of at most 16. No abort, no skipped step, no 412, no security header.
- **Cleanup:** none needed. Both bookings were seen cancelled by the closing records check, so no
  `PAIR_CLEANUP` line was printed and nothing was left at the business.
- **Owner's observation in Altegio Pro** (both records under the owner's name, one visit or two):
  not checked.
- **What the run does not show:** the Cloud Run egress and its anti-fraud behaviour (WRITE-07, B3),
  other businesses and their settings, the same-team-member refusal for the create (only the
  check was run), two "any" entries (A2), and how the business displays the two records.

## Backlog (IN)

- A client-token waiting list; it needs an API change, because `/location/{id}/waiting_list` is a
  staff-token route.
- `confirmed_by_client` (attendance 2) on upcoming bookings as a hold signal.
- A common-slots read tool (`business_list_common_slots`) if the model's intersection of two
  team members' slots proves error-prone.
