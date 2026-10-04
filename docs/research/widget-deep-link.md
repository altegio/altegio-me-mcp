# Booking widget deep link (B4)

Research date: 2026-10-03. Answers open question B4 without the backend team, at the owner's
request. Sources: `altegio/client.booking` and `altegio/biz.erp` code (read via `gh`), the
deployed widget bundle and live redirects (GET only, no bookings).

## Verdict

Safe to build on for v1, with a fallback link. The format has been stable since December 2020,
the deployed widget still contains the parser, and biz.erp already produces these links in
production. Only the staff and service tokens have an outside producer; the time token is used by
the widget alone, and an invalid time is silently ignored. Final confirmation is the Phase 2
browser check (BOOK-04).

## Grammar

Parser: `libs/utils/src/lib/helpers/map-url-to-record/map-url-to-record.ts`. Writer:
`OrderState.toString()` in `apps/client.booking/src/app/shared-modules/order-manager/order-state.ts`.

- Query key `o`. Tokens are matched by regex anywhere in the value, not by position. Put `m`
  first: otherwise the staff regex can match the `m` inside a sub-service `sm` token.
- Staff: `m{staffId}`. Any professional: `m-1`. `m0` means no staff.
- Services are concatenated: `s1s2s3`. The comma form `s1,2,3` is still read but deprecated.
  Composite services: `s{id}ss{linkId}sm{staffId}`.
- Time: `d` plus exactly 10 digits, **YYDDMMHHmm (day before month)**, in the business's local
  wall-clock time. The widget adds the company's UTC offset from its `timezone` field.
- Group events: `aid{eventId}c{seats}` (repeatable, seats up to 99) and `act{YYYY-MM-DD}`.
  `act` reads up to the next comma or the end, so put it last.

Examples (demo location 722227, form 1463903; 2026-10-05 14:00):

- `https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400`
- `https://n1463903.alteg.io/company/722227?o=m-1s10303530s10303531d2605101400`
- `https://app.alteg.io/book/722227?o=m2098145s10303530d2605101400`: 302 to the default form with
  `o` passed through, so the builder does not need the form id.

## Landing behaviour

`/company/{loc}` redirects to `/record-type`, then to the form's first step with `o` kept.
Depending on the form settings that is the summary menu (`personal/menu`, Continue enabled when
everything is filled), `select-services`, or the record-type chooser. It never skips to the
contact step. The contact step is `/company/{loc}/create-record/record`; linking there directly is
unsafe because it waits silently when the order is incomplete.

Bad input is handled silently (`generateInitObservables` in `order-manager.service.ts`): unknown
or non-bookable services are dropped; an unavailable staff member is replaced by the widget's
auto-pick; the time is applied only if it equals a free slot's `datetime` exactly, otherwise the
date resets to today with no time selected.

## Stability evidence

- First built 2020-12-18/22 (`f8246d914e`, `65f1e46eae`), moved to the current path on
  2020-12-29 (`0a65978f2d`). Ten commits at the current path, last parser change 2025-05-13
  (`d0304b6a06`); every change only added tokens (`m-1` 2021, `act` 2022, `c` 2023, `aid` 2024,
  composite and concatenated services 2024-12).
- Tests: `map-url-to-record.spec.ts` covers three date cases only; nothing tests the grammar.
- Outside producer: biz.erp `src/More/BookingForm/Service/BookingFormUrlService.php::getBookingFormUrlForService`
  builds `https://n{form}.alteg.io/company/{loc}?o=m{staff}s{id}s{id}` (since 2024-07-25,
  staff and multiple services since 2025-06-19). It serves `/book/{salonId}` and the "book again"
  link in review-request emails.
- No outside producer of `d`: Reserve with Google, SMS booking links and repeat-visit
  notifications use plain links.
- Live check: `n1463903` and `b1463903` serve the same bundle; lazy chunk (last modified
  2026-09-04) contains `YYDDMMHHmm`, `aid`, `act`, `ss`, `sm`, the same regexes and the same
  day-month conversion.

## Form URL and fallback

`GET /company/{id}?showBookforms=1` (or `showDefaultBookformUrl=1`) returns
`bookforms[{id, title, is_default, url}]` and `default_bookform_url` (`src/CTraitCompanyApi.php`).
Fallback when nothing can be pre-selected: `default_bookform_url`, or
`https://app.alteg.io/book/{loc}` (302 to the default form, 404 when there is none). Some regions
use `altegio.asia` or `altegio.org` hosts instead of `alteg.io`.

## Still to check in a real browser (Phase 2)

Each item points to its row in "Browser check results" below.

- The time shows as selected in both menu-style and step-by-step forms. Rows `single-named`
  and `menu-and-steps`.
- Half-hour time zones (the offset helper likely renders 5.5 as `+05:50`) and dates across a
  daylight-saving change. Rows `half-hour-zone` and `dst-boundary`.
- `m-1` when "any professional" is disabled or the staff step is hidden. Rows `any-member` and
  `any-member-disabled`.
- Forms that first ask to choose between a personal booking and a group event. Row
  `personal-or-group`.
- `{slug}.altegio.me` hosts. Row `slug-host`.
- Group-event token order: the widget writes `act` before `aid`, which by the parser's rules
  swallows `aid`. Row `group-event-order`.
- What the client sees when the slot is already taken. Row `taken-slot`.

## Browser check procedure (BOOK-04)

`scripts/browser-check/` is a local, repeatable check of the links above in a real browser. It is
an isolated package (own `package.json` and lockfile, `playwright` pinned at exactly 1.63.0 after
owner approval). The root package, CI and the Docker image never install it. Results of the runs
are recorded by plan 02-11.

### Prerequisites

- Root `.env` with `ALTEGIO_API_TOKEN` (the partner token) and `ALTEGIO_E2E_LOCATION_ID` (the
  test business). The token is only sent to the API; the check never prints it or writes it to
  results or screenshots.
- Root dependencies installed (`npm ci`); the check runs through the root `tsx` and `tsc`.
- `npm --prefix scripts/browser-check ci --ignore-scripts` (installs the pinned Playwright, no
  install scripts, no browser download).
- Google Chrome installed (`/Applications/Google Chrome.app`); the check drives it with
  `channel: 'chrome'`, headed.

### Commands

```bash
npm --prefix scripts/browser-check run cases                 # list the case ids, no network
npm --prefix scripts/browser-check start                     # run every case in Chrome
npm --prefix scripts/browser-check start -- --print-links    # links only, for the manual fallback
npm --prefix scripts/browser-check run typecheck             # type-check the check
```

`start` finds free slots with the repo's own `BookingClient`, confirms each one with
`book_check` (201), builds the link with the shipped `buildBookingLink` (or `plainBookingLink`),
opens it in a fresh Chrome context, waits up to 30 s for the widget to settle, reads the page text
and saves a screenshot. Expectations are plain text only (service title, team-member name,
`HH:MM`, day of month), because the widget DOM is not a contract. A case is `pass`, `fail`,
`not-run` (with the reason) or `blocked` (Cloudflare challenge page). Exit code 1 means at least
one case failed.

Cases: `single-named`, `multi-services`, `any-member`, `plain-fallback`, `taken-slot`,
`menu-and-steps`, `personal-or-group`, `half-hour-zone`, `dst-boundary`, `any-member-disabled`,
`slug-host`, `group-event-order`. Together they cover the BOOK-04 core (service, team member and
time pre-selected), the BOOK-05 plain link and every item of "Still to check in a real browser".
Links of kind `probe` bypass one builder guard on purpose (half-hour offset, offset after a
daylight-saving change, any team member disabled, `altegio.me` host) to see what the widget does
with the link the builder refuses to give out.

Optional variables, for businesses that show the edge cases (each case is `not-run` without
its variable):

- `BROWSER_CHECK_STEPS_LOCATION_ID`: a business whose form uses the other style (step by step
  when the test business uses the menu, or the reverse).
- `BROWSER_CHECK_HALF_HOUR_LOCATION_ID`: a business in a half-hour time zone (for example
  +05:30).
- `BROWSER_CHECK_ANY_DISABLED_LOCATION_ID`: a business with "any team member" disabled.

Run options:

- `BROWSER_CHECK_MIN_LEAD_HOURS` (positive whole hours, default 0 = no minimum): discovery skips
  every slot that starts sooner than that many hours after discovery begins, for every slot-based
  case, and takes the first verified free slot after that. Use it to keep the linked slot away
  from the widget's own minimum lead time, for example `BROWSER_CHECK_MIN_LEAD_HOURS=24`. Each
  case's `seen` notes how far ahead its slot starts.
- `BROWSER_CHECK_REPEAT_LOADS` (positive whole number, default 3): after the cases, the
  `single-named` link is opened that many more times, each in a fresh context with the same 30 s
  wait, read-only like every case. `results.json` gets a `repeat_loads` entry with each load's
  checks, final URL, the time range the widget showed and a screenshot
  (`single-named-repeat-<n>.png`), plus a tally of how many loads applied the service, the team
  member and the time. It shows whether the pre-selection holds on every load. The tally does not
  change the exit code.

### What the check never does

It never clicks, types, fills, presses or submits anything in the widget, and it aborts any
request to the booking write route, so no booking can result. The only POST it sends is the
`book_check` validation route, which creates no record.

### Results

Each run writes `scripts/browser-check/output/<timestamp>/results.json` (`run_at`,
`chrome_version`, `location_id`, `form_id`, `time_zone`, `utc_offset_hours`, `discovered_at`,
`min_lead_hours`, one entry per case with `link`, `link_kind`, `expected`, `seen`, `status`,
`reason`, `screenshot`, and `repeat_loads`) and one PNG per case and per repeated load, then prints a Markdown results table
and the repeated-load tally. The output folder is git-ignored.

### Manual fallback

Use it when Cloudflare challenges the automated browser (cases `blocked`) or Chrome cannot be
driven:

1. Run `npm --prefix scripts/browser-check start -- --print-links`. It prints, per case, the
   link, its kind and what to expect, or why the case is not run.
2. Open each link in a normal Chrome window (a fresh profile or a private window).
3. Without filling anything in, note what is pre-selected: services, team member, date and time,
   and which form style or chooser the widget lands on. Take a screenshot.
4. Fill the results table (case, status, link kind, seen or reason, screenshot) the same way
   the scripted run prints it.

## Browser check results

- Run: 2026-10-04 07:11 UTC
  (`ALTEGIO_E2E_LOCATION_ID=726120 BROWSER_CHECK_MIN_LEAD_HOURS=24 npm --prefix scripts/browser-check start`),
  Google Chrome 154.0.8037.93, headed, Playwright 1.63.0.
- Location 726120 "BaBarber", booking form 1472304. Link host `n1472304.alteg.io`. The business
  card reported time zone Europe/Warsaw (+02:00) for this run.
- Demo location 722227, used in the examples above, could not be used: its widget is inactive
  (`company.active` 0, see plan 02-09). The owner chose 726120 instead, and on 2026-10-04
  configured it for this check (services enabled for online booking, team members bookable,
  schedules for the coming days). The run passed the location as `ALTEGIO_E2E_LOCATION_ID=726120`
  in the process environment, so the local env file was not changed.
- Slot: the first verified free slot at least 24 h after discovery, so no shorter lead was needed:
  2026-10-05 12:00 local time, 26 h 49 min ahead, with team member Max Rivera (3110938) and service
  "VIP Barber Package" (13884511); the second service is "Face Care" (13884510). `any-member`
  used 2026-10-05 09:30, 24 h 19 min ahead. `book_check` returned 201 for each linked combination
  before its link was opened.
- Evidence: `scripts/browser-check/output/2026-10-04T07-11-30-435Z/` (git-ignored) holds
  `results.json` and one PNG per run case: `single-named.png`, `multi-services.png`,
  `any-member.png`, `plain-fallback.png`, `taken-slot.png`, `menu-and-steps.png`,
  `personal-or-group.png`, `dst-boundary.png`, plus `single-named-repeat-1.png` to
  `single-named-repeat-3.png`.

| Case | Link kind | Expected | Seen | Result | Note |
|------|-----------|----------|------|--------|------|
| single-named | preselected | service, team member and time pre-selected | menu form: Max Rivera, "Monday, 5 October 12:00 — 12:33", VIP Barber Package | pass | BOOK-04 core; link `?o=m3110938s13884511d2605101200` |
| multi-services | preselected | two services, team member and time pre-selected | Max Rivera, "Monday, 5 October 12:00 — 12:33", VIP Barber Package and Face Care (1 h each) | pass | link `?o=m3110938s13884511s13884510d2605101200` |
| any-member | preselected | service and time pre-selected with `m-1` | "Any available professional", "Monday, 5 October 9:30", VIP Barber Package | pass | link `?o=m-1s13884511d2605100930` |
| plain-fallback | booking_form | form opens with nothing pre-selected | lands on `/company/726120/personal/menu?o=` (empty `o=`), menu style, nothing selected | pass | BOOK-05 link |
| taken-slot | preselected | no time selected for a non-free time (12:01) | widget dropped the `d` token (final URL `?o=m3110938s13884511`); team member and service kept, no time | pass | matches the silent reset described in "Landing behaviour" |
| menu-and-steps | preselected | time shown in the menu form | same link as single-named; 12:00 — 12:33 selected | pass | menu style only; `BROWSER_CHECK_STEPS_LOCATION_ID` not set, so the step-by-step style was not run |
| personal-or-group | preselected | no personal-or-group chooser | same link as single-named; lands on the menu with team member, 12:00 — 12:33 and the service selected | pass | the form offers no group events, so no chooser exists to skip |
| half-hour-zone | - | time kept in a half-hour zone | - | not-run | `BROWSER_CHECK_HALF_HOUR_LOCATION_ID` not set |
| dst-boundary | probe | time kept for a slot after the offset change | 2026-10-25 12:00 (+01:00, after Europe/Warsaw leaves summer time) linked with its own offset: Max Rivera and the service kept, date row says "Select date and time"; `d` token still in the final URL | fail | probe link; the shipped builder refuses this slot (`offset_mismatch`) and returns the plain booking-form link, which this result supports |
| any-member-disabled | - | widget reaction to `m-1` when disabled | - | not-run | `BROWSER_CHECK_ANY_DISABLED_LOCATION_ID` not set |
| slug-host | - | same link on an `altegio.me` host | - | not-run | no booking form of 726120 is on an `altegio.me` host |
| group-event-order | - | - | - | not applicable | group events are deferred (EXT-01); the builder never writes `aid` or `act` |

Repeated loads (`BROWSER_CHECK_REPEAT_LOADS` default 3): after the cases, the `single-named` link
was opened 3 more times, each in a fresh context with the same 30 s wait, starting at 07:13:03,
07:13:11 and 07:13:20 UTC.

| Applied | Loads |
|---------|-------|
| service "VIP Barber Package" | 3 of 3 |
| team member "Max Rivera" | 3 of 3 |
| time 12:00 | 3 of 3 |
| day 5 | 3 of 3 |
| everything at once | 3 of 3 |

Every load showed "12:00 — 12:33". The widget shows the same 33-minute end on every load and in
every run, although it lists the service as "1 h", and also in `multi-services` with two 1 h
services (run 2 showed "14:00 — 14:33"). That end comes from the widget's own duration data, not
from the link, which carries only the start.

Two more runs the same morning had the same twelve results and 3 of 3 repeated loads:

- 07:07 UTC, also with a 24 h lead (`output/2026-10-04T07-07-46-424Z/`). That run is why the
  check now records the time zone: its slot offsets (+02:00) no longer matched run 2.
- 07:13 UTC, a control run with no minimum lead (`output/2026-10-04T07-13-56-686Z/`): the first
  free slot was today 12:00, 2 h 46 min ahead, and `any-member` linked today 09:30, only 16 min
  ahead, and still had its time applied.

Across these three runs the widget applied the time on all 24 loads that linked a free slot
(`single-named`, `multi-services`, `any-member`, `menu-and-steps`, `personal-or-group` and three
repeated loads per run).

Run 2, for context (06:41 UTC, `output/2026-10-04T06-41-30-024Z/`): the business card then said
Asia/Bangkok (+07:00), and discovery took the nearest slot, 2026-10-04 14:00 local, 16 to 19 min
ahead. `single-named` and `personal-or-group` showed the time, but `multi-services`, `any-member`
and `menu-and-steps` (the same link as `single-named`) kept the team member and services and left
the time unselected. The owner confirmed on review (2026-10-04) that they changed the time zone of
location 726120 from Asia/Bangkok to Europe/Warsaw during run 2, at about 06:41 to 06:44 UTC.
The links of run 2 were built from slots discovered under the old zone and opened while the zone
was being changed. The run 2 drops come from that change, not from a widget defect and not from
the near slot: the 07:13 UTC control run linked a slot only 16 min ahead and the widget still
applied its time. An earlier run at 06:13 UTC, before the setup, found no bookable service and no
free time, so only `plain-fallback` could run then. `src/booking/deep-link.ts` was not changed.

B4 status: confirmed in browser on 2026-10-04 (location 726120, form 1472304, Europe/Warsaw) for
single-named (service, team member and time pre-selected, and 3 of 3 repeated loads), multi-services,
any-member, menu-and-steps (menu style only), personal-or-group, plain-fallback (BOOK-05, nothing
pre-selected) and taken-slot (a non-free time is dropped); a slot after a daylight-saving change
does not keep its time (dst-boundary probe), which the builder already handles by returning the
plain booking-form link; half-hour-zone, any-member-disabled and slug-host were not run; the
time drops of the earlier run 2 came from the owner's time-zone change of the location during
that run and did not recur in 24 later loads.

Owner review: 2026-10-04, approved with corrections (no change to the case rows; the run 2 note
now names the owner's time-zone change as the cause of its time drops)
