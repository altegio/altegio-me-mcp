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

### What the check never does

It never clicks, types, fills, presses or submits anything in the widget, and it aborts any
request to the booking write route, so no booking can result. The only POST it sends is the
`book_check` validation route, which creates no record.

### Results

Each run writes `scripts/browser-check/output/<timestamp>/results.json` (`run_at`,
`chrome_version`, `location_id`, `form_id` and one entry per case with `link`, `link_kind`,
`expected`, `seen`, `status`, `reason`, `screenshot`) and one PNG per case, then prints a Markdown
results table. The output folder is git-ignored.

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

- Run: 2026-10-04 06:13 UTC (`npm --prefix scripts/browser-check start`), Google Chrome
  154.0.8037.93, headed, Playwright 1.63.0.
- Location 726120 "BaBarber", booking form 1472304. Link host `n1472304.alteg.io`.
- Demo location 722227, used in the examples above, could not be used: its widget is inactive
  (`company.active` 0, see plan 02-09). The owner chose 726120 instead on 2026-10-04. The run
  passed the location as `ALTEGIO_E2E_LOCATION_ID=726120` in the process environment, so the
  local env file was not changed.
- Evidence: `scripts/browser-check/output/2026-10-04T06-13-33-050Z/` (git-ignored) holds
  `results.json` and `plain-fallback.png`. It also holds three read-only widget screenshots,
  taken by opening the step URLs directly without any click: `widget-probe-select-master.png`,
  `widget-probe-select-services.png` and `widget-probe-select-time.png`.
- What discovery found: the partner API lists 8 team members at 726120, none of them bookable,
  and 0 services bookable online. The widget shows the same thing: all 8 professionals are
  listed, "Select services" says "Nothing found", and "Select date and time" says "There are no
  available spots for upcoming months". With no free slot to verify with `book_check`, the check
  had no pre-selected link to open.

| Case | Link kind | Expected | Seen | Result | Note |
|------|-----------|----------|------|--------|------|
| single-named | - | service, team member and time pre-selected | no link: 8 team members, 0 bookable | not-run | location has no free slot (BOOK-04 core not shown) |
| multi-services | - | two services pre-selected | no link: 8 team members, 0 bookable | not-run | location has no free slot |
| any-member | - | service and time pre-selected with `m-1` | no link: 0 services for any team member | not-run | location has no service bookable online |
| plain-fallback | booking_form | form opens with nothing pre-selected | lands on `/company/726120/personal/menu?o=` (empty `o=`), menu style, nothing selected | pass | BOOK-05 link |
| taken-slot | - | no time selected for a non-free time | no link | not-run | needs a free slot to shift by one minute |
| menu-and-steps | - | time shown in the menu form and the step form | main form is menu style (from plain-fallback); no link | not-run | needs a free slot; `BROWSER_CHECK_STEPS_LOCATION_ID` not set |
| personal-or-group | - | no personal-or-group chooser | plain link skips the chooser and lands on the menu | not-run | the pre-selected link was not opened |
| half-hour-zone | - | time kept in a half-hour zone | - | not-run | `BROWSER_CHECK_HALF_HOUR_LOCATION_ID` not set |
| dst-boundary | - | time kept after an offset change | no link | not-run | needs a free slot |
| any-member-disabled | - | widget reaction to `m-1` when disabled | - | not-run | `BROWSER_CHECK_ANY_DISABLED_LOCATION_ID` not set |
| slug-host | - | same link on an `altegio.me` host | no link | not-run | needs a free slot |
| group-event-order | - | - | - | not applicable | group events are deferred (EXT-01); the builder never writes `aid` or `act` |

B4 status: partial: the plain booking-form link (BOOK-05) opened the form with nothing
pre-selected on 2026-10-04 (location 726120, form 1472304); the BOOK-04 core (service, team
member and time pre-selected) was not shown in a browser, because location 726120 has no service
bookable online and no free time, so no pre-selected link could be verified and opened.

Owner review: pending
