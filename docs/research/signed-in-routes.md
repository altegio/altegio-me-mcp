Contract status: recorded 2026-10-08 on location 726120

# Signed-in routes: the client's places and bookings

Research date: 2026-10-08 (plan 04-01, decision D-02). Answers what `me_list_places` and
`me_list_bookings` can read, from one live recording of each route. Both routes are
undocumented; the shape below is what the recording showed, not a published contract. The
sanitised recordings are `src/booking/__tests__/fixtures/live/user_yplaces.json` (3 places) and
`src/booking/__tests__/fixtures/live/user_records.json` (12 records); the route schemas are
`userPlacesDataSchema` and `userRecordsDataSchema` in `src/booking/schemas.ts`.

## How the contract was recorded

- The owner signed in once by hand with curl, outside the repository, through the documented
  phone-code sign-in (`POST /book_code/{loc}`, then `POST /user/auth`) on location 726120. No
  phone number, code or token is in this document, in a recording or in git. This server never
  calls the sign-in routes (SEC-02).
- The opt-in suite `src/booking/__tests__/user-routes.live.test.ts` (ALTEGIO_E2E=1,
  ALTEGIO_E2E_USER=1) made exactly two calls, one per route, and wrote the sanitised answers. The
  owner ran it; it passed (both answers 200 with a list, no token in any encoded form in either
  recording, two upstream calls).
- Auth on both routes: `Authorization: Bearer <partner token>, User <user token>`, with
  `Accept: application/vnd.api.v2+json`. The partner token is the one of developer account 2630.
- Both routes are undocumented. The per-record route `GET /user/records/{id}/{hash}` is not used
  by this server: the hash is a bearer secret for that booking.

## GET /user/companies/yplaces

- **Query sent:** none. **Parameters the backend accepts:** not checked. The route is
  `api.booking.user_companies.yplaces.list` in biz.erp's routing, served by
  `BookingUserSalonController::action_salons_yplaces`; the deprecated twin is
  `/user/salons/yplaces`. A `/favorites` sub-route exists (a `PUT` writes), which this server
  does not use.
- **Answer:** `data` is a list, 3 items, in ascending id order. No pagination was seen and none
  can be ruled out. The list holds places where the client has records; 726120, where the code
  was requested, was not in it, and one business of the records list was not
  in it either, which fits "only businesses that installed the Altegio.me app"
  (altegio-booking-api.md, Discovery).
- **Item keys observed:** `id` int, `title`, `public_title`, `address`, `zip`, `logo`, `site`,
  `short_descr`, `phone` and `phones[]` (strings; `''` and `[]` when the business has none),
  `business_group_id`, `business_type_id`, `country_id`, `city_id`, `timezone` (UTC hours, int),
  `timezone_name`, `coordinate_lat`, `coordinate_lon`, `allow_delete_record` bool,
  `allow_change_record` bool, `active_status` object `{is_active bool, is_enabled_gca bool}`.
  There is no `city` text and no `active` key.

| Tool field (D-02) | Key | Note |
| --- | --- | --- |
| location id | `id` | feeds `business_get` and the rest |
| name | `public_title`, else `title` | both are removed in the recording |
| address | `address` | |
| city | none | the item carries only `city_id`; a city name exists in `company.city` of a record at that place |
| logo | `logo` | |
| online booking enabled | `active_status.is_active` | `is_enabled_gca` looks like "enabled in the general client app" (biz.erp names it `getGeneralClientAppRecordsInfo`); the widget flag stays `business_get`'s `active` |
| last visit | no key | derive from `GET /user/records` (latest kept record in the past) |

## GET /user/records

- **Query sent:** none. **Parameters the backend accepts:** not checked
  (`BookingRecordInfoRequestDto` in `UserRecordsController::action_read`). biz.erp also routes
  `GET /user/records/yplaces` (`action_list_yplaces`, with payment-policy includes), the route
  altegio.me itself reads; it is not recorded here and not used.
- **Answer:** `data` is a list, 12 items across 4 businesses, **oldest first** (ascending
  datetime), so "upcoming first" is the tool's own sorting. No pagination was seen with no query
  sent; whether a long history is cut or paged is unknown. The recorded list had no upcoming
  record, 3 cancelled ones and one with no services.
- **Cancelled records stay in the list** with `deleted: true` (and `attendance` 0). A cancelled
  record must not be shown as a booking.
- **Item keys observed:** `id`, `token`, `record_token`, `api_id`, `clients_count`, `date`
  (`Y-m-d H:i:s`, business local time), `datetime` (ISO 8601 with an offset **without a colon**,
  for example `+0700`, unlike the slot datetimes of `book_times`), `create_date`,
  `last_change_date`, `comment`, `deleted` bool, `attendance` int (1 on past kept records, -1 on
  one, 0 on cancelled ones; the meaning is inferred), `length` seconds, `paid_amount`,
  `prepaid`, `prepaid_confirmed`, `activity_id`, `online`, `review_enabled`,
  `allow_delete_record`, `allow_change_record`, `notify_by_sms`, `notify_by_email`,
  `master_requested`, `is_confirmation_needed`, `is_acceptance_payment`, `payment_failure`,
  `is_show_prepay_button`, `acceptance_free`, `resource_instances[]`, and three objects:
  - `company`: `id`, `title`, `public_title`, `address`, `city`, `city_id`, `country`,
    `country_id`, `phone`, `phones[]`, `site`, `social{}`, `logo`, `map`, `timezone`,
    `currency_short_title`, `coordinate_lat`, `coordinate_lon`, and `allow_*` flags. Its
    `timezone` was 8 for a Phuket business whose record datetimes carry `+0700`: read the
    offset of `datetime`, never `company.timezone`.
  - `services[]`: `id`, `title`, `cost`, `amount`, `discount`, `price_min`, `price_max`,
    `seance_length`, `api_id`, `prepaid_settings{}`.
  - `staff`: `id`, `name`, `specialization`, `position` (an object, or `[]`), `rating`,
    `votes_count`, `comments_count`, `avatar`, `avatar_big`, `is_deleted`. It was an object in
    all 12 records; the schema also accepts `[]`.
- There is no `client` object, no `client_id` and no `hash` key in this shape. The record
  secrets are `token`, `record_token` and `api_id`.

| Tool field (D-02) | Key | Note |
| --- | --- | --- |
| business | `company.id`, `company.public_title` (else `title`) | |
| services | `services[].id`, `services[].title` | a record can have none |
| team member | `staff.id`, `staff.name` | |
| datetime | `datetime` (offset without a colon), `date` (local) | |
| status | `deleted`, `attendance`, and the datetime against now | |
| price | `services[].cost` x `amount`, less `discount`, in `company.currency_short_title` | no record total key; `paid_amount` is what was paid; the sum is a service-cost sum and can exclude taxes or fees listed as services |

## Personal data in the answers and what the sanitiser does

| Key | Where | Sanitiser |
| --- | --- | --- |
| `phone`, `phones` | places, `company` | `+10000000000` |
| `title`, `public_title` | places; `company` of a record | `[removed]` (a service title stays) |
| `address`, `zip` | places, `company` | `[removed]` |
| `coordinate_lat`, `coordinate_lon` | places, `company` | `0` |
| `logo`, `avatar`, `avatar_big` | places, `company`, `staff` | placeholder image URL |
| `site`, `social` | places, `company` | placeholder URL |
| `comment` | record | `[removed]` |
| `staff.name` | record | `Team member <staff id>` |
| `token`, `record_token`, `api_id` | record | `[removed]` (an empty or null value stays) |
| `id` | record | renumbered 1..n in recorded order |
| e-mail in any text | anywhere | `[removed]` |
| both tokens | anywhere | `[redacted]` |

The recorder also replaces `hash` and `*_hash` keys, `client_id`, `user_id`, `*_account_id`, the
`id` and every name key of a `client` object, and the name of a `master` object; none of those
appeared in this recording. `token`, `record_token` and `api_id` were not in the first
sanitiser: the first recording was read through, the three keys were added with test-first
cases, and the two files were re-sanitised before commit.

Kept as the API wrote them, as the plan decided: location, service and team member ids, service
titles, prices and currency, dates and datetimes, `city`, `country`, `short_descr` and
`staff.specialization`. The dates and service titles of the recording are the booking history of
the test client; the businesses are public places.

## What 04-02 and 04-03 build on

- Parse both lists with the loose schemas; tolerate `[]` for `company`, `staff` and `position`.
- Sort records in the tool: upcoming first (by the offset-bearing `datetime`), then the most
  recent past; drop or label `deleted` ones.
- The usual service and team member at a place come from that place's latest kept past record.
- Last visit and city text are derived from records, not from the places route.
- Unknowns that a later live run can settle: query parameters and paging of both routes, and the
  meaning of `attendance` and `is_enabled_gca`.
- The contract fixtures `user_yplaces.json` and `user_records.json` follow this shape with
  synthetic values: location 722227 (active) and 726120 (inactive); five records (two kept past at
  722227 sharing one service and team member of the default `book_*` fixtures, one cancelled there,
  one in 2099, and one past at 726120). Bait values for the non-echo tests: phone `+15550000001`
  (places and `company`), `Fixture Client` and `fixture.client@example.invalid` (in the first
  record's `comment`), and `fixture-hash-0001` (in `token` and `record_token` of the first record).

## Local end-to-end run

Run once on the owner's machine with the owner's own user token, through the direct
`X-Altegio-User-Token` header (the proxy's headless shape) with `CALLER_AUTH=optional`. This is
ROADMAP criterion 2 of Phase 4 on real data. The claude.ai OAuth run waits for I8 (Phase 6
acceptance). No token, phone, name or code is in this record, and the link is described, not quoted.

- **When:** 2026-10-08 07:20 UTC (14:20 UTC+7).
- **Commit:** e45ab9b (branch `phase-04-own-places`, plan 04-04).
- **Command:** `ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 node --env-file=.env ./node_modules/jest/bin/jest.js --testPathPatterns=me-flow.live --runInBand`
  (`src/__tests__/me-flow.live.test.ts`; the real app in process, the production request gate,
  one sequential call per step).

| Step | Tool | Result |
| --- | --- | --- |
| 1 | `me_list_places` | 3 places; the first with online booking and a usual is location 731063 |
| 2 | `me_list_bookings` | 12 bookings, no error |
| 3 | `business_list_dates` with the usual | a free date: 2026-10-11 |
| 4 | `business_list_time_slots` for that date | a free slot: 2026-10-11T17:15:00+07:00 |
| 5 | `book_check` | status `verified`, link kind `preselected` |

- **The usual of place 731063:** services 12391130 and 12378557, team member 2178363.
- **The link:** the business's own booking form on an `alteg.io` host, `/company/731063`, with
  `?o=m2178363s12391130s12378557d2611101715`: the team member, both services in order and the slot
  time (day before month, 11 Oct 2026, 17:15). It holds ids and a time only.
- **Upstream calls:** 9 of at most 12. No response text and no log line held either token (the
  test asserts it).
- **Test correction after the run.** 6 of the 7 tests passed. The failing one, the `book_check`
  link check, was a bug in the assertion: it expected `m<staff>s<first service>d`, while the usual
  has two services and the link correctly names both. The assertion now expects `m<staff>`, every
  service id in order, then `d` (commit 27ed672; the fixture flow in `me-flow.test.ts` got the same
  form first). The suite was not rerun, since it reads the owner's `.env`; the recorded link
  satisfies the corrected check (checked against the saved run output). The product behaviour was
  not changed.
- **Container smoke:** `docker build -t altegio-me-mcp:phase-04 .` and
  `bash scripts/smoke.sh altegio-me-mcp:phase-04` printed `PASS smoke: ... mcp_call_lines=7
  refusal_lines=1 user=node stop=0s exit=0`, and the HTTPS fixture printed `PASS: signed HTTPS
  initialize and eight-tool catalog, stateless responses`. A signed client identity without
  `mcp:me:read` got HTTP 200 and an in-band refusal of `me_list_places` naming the sign-in, and its
  canary user token is in no log line.
- **What this does not show:** the proxy's phone and SMS sign-in and the OAuth step (I8); a booking
  (none was made; the owner closed the widget before the contact step).

Owner review: completed 2026-10-08, pre-selection confirmed (the widget opened with the selection
pre-filled).

## Writes

Research date: 2026-10-08 (plan 04.1-01, decisions D-02 and D-05). Answers what `me_book`,
`me_reschedule_booking` and `me_cancel_booking` send and can read, from one live create, move and
cancel of a real booking. The four routes were recorded: GET `/booking/user/data` (the profile),
POST `/book_record/{loc}` (create), PUT `/book_record/{loc}/{record_id}` (move) and DELETE
`/user/records/{record_id}/{hash}` (cancel). The sanitised recordings are
`src/booking/__tests__/fixtures/live/booking_user_data.json`, `book_record_create.json`,
`book_record_move.json` and `user_record_cancel.json`; the route schemas are `bookingUserDataSchema`,
`bookRecordCreateDataSchema`, `bookRecordMoveDataSchema` and `userRecordCancelDataSchema` in
`src/booking/schemas.ts`; the contract fixtures of the same four names under
`src/booking/__tests__/fixtures/` carry the scenarios plans 04.1-02 and 04.1-03 test against.
No token, record hash, phone, name, login or e-mail is in this section, in a recording or in git.

### How the writes were recorded

- **When:** the run that passed was the fourth, on 2026-10-08 at 11:56 UTC (18:56 UTC+7).
- **Commit:** 976be82 (branch `phase-04.1-in-chat-booking`, plan 04.1-01).
- **Command (the owner's shell, the executor never opens the env file):**
  `ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_RECORD=1 node --env-file=.env ./node_modules/jest/bin/jest.js --testPathPatterns=user-writes.live --runInBand`
  (`src/booking/__tests__/user-writes.live.test.ts`). Direct calls with
  `Authorization: Bearer <partner>, User <user>`, from the owner's machine, not from Cloud Run.
- **Where:** location 726120 (the owner's own business), service 13884511 (prepaid `forbidden`, no
  membership restriction, picked from `book_services`, not from a usual), team member 0 (any), first slot 2026-10-10T09:00+02:00, moved to 10:00+02:00.
- **Calls:** 9 of at most 14: profile, `book_services`, `book_dates`, `book_times`, create,
  `GET /user/records`, move, cancel, `GET /user/records`. Nothing was left behind: the closing
  records check showed the record `deleted`, and no cleanup call was needed.
- **Earlier attempts on the same day:** three runs stopped at the create with HTTP 422 before this
  one (see "Required e-mail" below). They created nothing: no record id came back, and no later
  step ran.

| Step | Route | Status |
| --- | --- | --- |
| 1 | `GET /booking/user/data` | 200 |
| 2 | `GET /book_services/726120` | 200 |
| 3 | `GET /book_dates/726120`, `GET /book_times/726120/0/{date}` | 200, 200 |
| 4 | `POST /book_record/726120` | **201**, record id present |
| 5 | `GET /user/records` | 200, the new record is in the list |
| 6 | `PUT /book_record/726120/{record_id}` | **200** |
| 7 | `DELETE /user/records/{record_id}/0` | **204**, no body |
| 8 | `GET /user/records` | 200, the record shows `deleted` |

### GET /booking/user/data (the profile)

- **Answer:** `data` is one object with the keys `0`, `id`, `user_token`, `name`, `surname`,
  `patronymic`, `phone`, `login`, `email`, `lang_id` and `avatar`. Key `0` repeats the user token. There
  is no `fullname` key in the recorded answer; the schema still accepts one.
- **The name** is `name`, with `surname` after it when that is non-empty (`patronymic` was empty and is
  not used). The suite sends `fullname` from the profile's `fullname`, else `name` and `surname` joined
  by one space.
- **The phone arrives as bare digits, with no plus** (11 digits for the owner). The documented create
  contract wants `+<digits>` (error 431, "Invalid phone number format", otherwise), so the server sends
  a plus and the digits only, whatever separators the profile used; an empty result means there is no
  usable phone. The recording cannot say whether bare digits would also have been accepted: the first
  run sent them and was refused for a reason that was not recorded, and the first run that sent
  `+<digits>` was refused for the e-mail. The rule follows the documented contract and the run that
  passed.
- **The e-mail** is `email`, and is empty when the client set none.
- Never returned to the chat: name, phone and e-mail only fill the create call.

### POST /book_record/{loc} (create)

- **Body sent, exactly:** `{ phone, fullname, email, appointments: [{ id: 1, services: [service],
  staff_id, datetime }] }`. `staff_id` is 0 for any team member, `datetime` is the slot string as
  `book_times` wrote it. No `code` (the user token replaces the SMS code), `comment`, `notify_*` or
  `api_id` key. `email` is always present: the profile's, or empty when it has none
  ([ADR 0009](../decisions/0009-email-key-always-sent.md); until 2026-11-09 it was sent only when
  non-empty).
- **Answer:** HTTP 201, `data` is `[{ id, record_id, record_hash }]`, one entry per appointment: `id` is
  the appointment id of the request (1), `record_id` the new record, `record_hash` a secret that this
  server never reads. A real 201 has a positive `record_id`; an entry without one means nothing was
  created (the fake 201 of the anti-fraud path, documented, not seen live).
- **The creation hash is not a field of the records list.** `GET /user/records` shows the new record
  with `token` and `record_token` that equal neither the creation hash (compared in memory, two
  booleans recorded, both false).

### Required e-mail (observed, open question)

- Three runs on 2026-10-08 stopped at the create with HTTP 422, before the passing one:
  1. the first, with the profile phone as read (bare digits) and no e-mail; the refusal body was not
     recorded then;
  2. the second, with `+<digits>` and no e-mail: `meta.message` "An error occurred", no code, and an
     `errors` that the first version of the recorder dropped because it is not a list;
  3. the third, same body: `meta.errors` is an **object keyed by a bracketed field name**:
     `{"[email]": ["The required parameter email was not passed."]}`, no `meta.code` and no code in
     the entries. The owner's profile had an empty e-mail.
- The passing run sent the profile e-mail (`email_sent` true) and `+<digits>`. Before it, the owner
  both **added an e-mail to the client profile and hid the Email field in the BaBarber booking
  form**, so the exact rule is not isolated: either "a field shown in the form makes the e-mail
  required" or "a profile e-mail is enough". The contract documents `email` as optional; this
  business, at least with the field shown, required it even for a signed-in client.
- **Explained (2026-11-09):** a body without the `email` key is refused this way whatever the
  business's settings: the API bug Jira SUP-506 (2024-08-16, still in Research). The booking widget
  always sends the key, empty when the client gave none. Live at 1389064 (no e-mail required): no
  key answered 422 as above, `"email": ""` answered 201 (ADR 0009, "Live check").
- **The rule the server follows** ([ADR 0009](../decisions/0009-email-key-always-sent.md)): always
  send `email`, the profile's when it is a non-empty text, empty otherwise. Until 2026-11-09 the
  rule was: send the profile e-mail when it is a non-empty text, nothing otherwise. When the
  business really demands an e-mail and none was given, the create answers 422 keyed on `email`;
  that case is an ME-08 fallback (an in-band reason and the pre-filled widget link), implemented in
  plans 04.1-02 and 04.1-03, keyed on the error record's `kind: "required_field"`, and the client
  may give the e-mail in the chat (ADR 0007). The wording of that refusal for an empty e-mail is not
  observed yet; any keyed `email` error after an empty one counts as the missing e-mail.
- **Error shapes seen and documented.** HTTP 422 with `meta.errors` as a list of
  `{code, message}` (433 slot taken, 436 no team member, 437 overlap, 431 phone, 432 code, 435 name),
  HTTP 403 with code 434 (blacklisted), and the keyed object above. Only the keyed object was seen
  live; the codes 431-437 are the documented ones, and the contract fixture `book_record_create.json`
  has a scenario for each, with a message quoting the synthetic bait `+15550000001 Fixture Client` so
  the tools can be tested not to echo it. `meta.errors` is therefore a list or an object keyed by
  field, and any code is `meta.code`, the first code of the list, or a top-level `code`.

### PUT /book_record/{loc}/{record_id} (move)

- **Body sent, exactly:** `{ datetime }` with the new slot string. No `comment` (documented, optional).
- **Answer:** HTTP 200, `data` is the moved record **in the shape of an entry of `GET /user/records`**:
  `id`, `token` (null), `record_token`, `clients_count`, `date` (local, `Y-m-d H:i:s`), `datetime`
  (ISO with an offset **without a colon**, here `+0200`), `create_date`, `last_change_date`,
  `comment`, `deleted`, `attendance`, `length`, the `allow_*` flags, `services[]`, `company` and
  `staff`. As in the records list, `company.timezone` (3) does not match the offset of `datetime`
  (+0200): read the offset of `datetime`. The answer's `id` is the booking's own id (sanitised to 1 in the recording).
- The move moved the booking to the next free slot with no confirmation step and no further field.

### DELETE /user/records/{record_id}/{hash} (cancel)

- **The hash segment answer:** the placeholder `0` was accepted. HTTP **204, no body**, with only the
  user token and the record id. No second attempt (the records-list field, the creation hash) was
  needed, so `hash_answer` is `placeholder`, and the creation hash is not needed to cancel a booking
  of the signed-in client.
- **The rule plan 04.1-03 follows:** `DELETE /user/records/{record_id}/0` with both tokens; a 2xx is a
  cancel, and anything else is reported as "could not cancel, contact the business", never retried
  with a different segment. A closing `GET /user/records` shows the record with `deleted` true.
- A 204 has no body, so the contract fixture `user_record_cancel.json` has `cancelled` as
  `{status: 204, body: ""}`; the test fake fetch serves such an answer with no body.

### Anti-fraud observations

- **Statuses seen on the three writes:** 201, 200 and 204. No 412 and no fake 201 (a 201 without a
  record id) was seen: the create returned a record id and the booking appeared in the records list.
- **Headers:** the recorder keeps the names of every response header of a write, and the values of
  `x-app-security-level` and of any header whose name contains `fraud`. No such header was present on
  the profile, the create, the move or the cancel (`security` is empty on all four recordings). The
  names seen were the Cloudflare, CORS and platform ones (`cf-ray`, `cf-cache-status`,
  `x-request-id`, `x-node-id`, `x-bounce-id`, `x-csp-token`, `x-feature-*`, `set-cookie` and the
  like); no value of any of them is recorded.
- **What a local run cannot show:** the run came from the owner's own network, with a residential
  address, not from the Cloud Run egress the server will call from. The anti-fraud behaviour is keyed on
  partner types and addresses (altegio-booking-api.md), so this says nothing about the egress. The
  412 and the fake 201 stay documented, not observed, and the contract fixtures
  `anti_fraud_412` (with a synthetic `X-App-Security-Level` value) and `fake_201` are built from the
  documentation. **WRITE-07 and B3 stay open** until a run from the Cloud Run egress.

### What the recorder removes

| Key | Where | Sanitiser |
| --- | --- | --- |
| `name`, `surname`, `patronymic`, `fullname`, `login` | profile, top level | `[removed]` (an empty one stays) |
| `id` | profile | `0` |
| `user_token` and every all-digit key (`0`) | profile | `[removed]` |
| `phone` | profile | `+10000000000` |
| `email` | profile | `[removed]` (an empty one stays) |
| `avatar` | profile, `staff`, `company` | placeholder image URL |
| `record_hash` | create answer | `[removed]` |
| `record_id` | create answer | `1` |
| `id` | move answer | `1` |
| `record_token`, `token`, `api_id` | move answer | `[removed]` (empty, null and numeric 0 stay) |
| `company.title`, `company.public_title`, `address`, phones, coordinates | move answer | as for the records list |
| `staff.name` | move answer | `Team member <staff id>` |
| `comment` | move answer | `[removed]` |
| both tokens | anywhere | `[redacted]` |

The header capture keeps names and the two kinds of security value only, so a cookie value never
reaches a file. The suite's own summary and run file (`loadtest-output/user-writes-run.json`,
git-ignored) are built from an allow-list of ids, slot times, statuses, header names, booleans and
the sanitised refusal records; the phone, name, e-mail, hash and both tokens are removed from every
text of a refusal, and the summary is withheld if it would hold one.

### Tool run

Run once on the owner's machine with the owner's own user token, through the direct
`X-Altegio-User-Token` header with `CALLER_AUTH=optional`, as the proxy's headless client would send
it. This is ROADMAP criteria 1 and 5 of Phase 4.1 and ME-06, ME-07 and ME-09 at the tool level: the
three write tools, each in its two-call shape, against a real business. The route-level contract
above is the evidence below it. No token, phone, name, record hash or confirmation token is in this
record; the summary the run printed holds only ids, slot times and statuses.

- **When:** 2026-10-08 14:05 UTC (21:05 UTC+7).
- **Commit:** ad0ffe5 (branch `phase-04.1-in-chat-booking`, plan 04.1-04).
- **Command (the owner's shell, the executor never opens the env file):**
  `ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 node --env-file=.env ./node_modules/jest/bin/jest.js --testPathPatterns=me-writes.live --runInBand`
  (`src/__tests__/me-writes.live.test.ts`; the real app in process, the production request gate, one
  sequential call per step). 13 of 13 tests passed.
- **Where:** location 726120, service 13884511 (picked from `business_list_services`, prepayment
  `not_offered`), team member 0 (any), first slot 2026-10-10T09:00:00+02:00, moved to
  2026-10-10T10:00:00+02:00.

| Step | Tool | Result |
| --- | --- | --- |
| 1 | `me_list_bookings` | ok |
| 2 | `business_list_services` | ok, a service without online prepayment |
| 3 | `business_list_dates`, `business_list_time_slots` | ok, ok: two free, non-overlapping slots two days ahead |
| 4 | `me_book`, first call | status `preview`, a confirmation token issued, nothing booked |
| 5 | `me_book`, second call | status `booked`, booking id 676218851 |
| 6 | `me_list_bookings` | ok, the booking is `upcoming` at the first slot |
| 7 | `me_reschedule_booking`, both calls | `preview`, then `moved` to the second slot |
| 8 | `me_cancel_booking`, both calls | `preview`, then `cancelled` |
| 9 | `me_list_bookings` | ok, the booking is `cancelled` |

- **Booking id:** 676218851, at 726120. It was seen cancelled by the closing list, so the cleanup
  did not run and no `ME_WRITES_CLEANUP` line was printed. Nothing was left at the business.
- **Upstream calls:** 24 of at most 30. No first failing step, no skipped step.
- **The suite's own checks passed:** no answer text and no log line held either token; a confirmation
  token appeared only in the preview answer that issued it; no answer held a phone-number pattern.
- **Anti-fraud:** none seen. `me_book` booked on its second call with no `fallback`, so the
  `not_confirmed` answer did not appear, and no fallback of any reason was returned.
- **What this does not show:** the run came from the owner's own network, not from the Cloud Run
  egress, so the anti-fraud behaviour keyed on partner types and addresses is still unobserved
  (WRITE-07 and B3 stay open). The proxy's phone and SMS sign-in and the OAuth step are not covered
  (I8); the run used the direct header. The move and cancel rules of other businesses are not
  covered either (726120 only).

### What 04.1-02 and 04.1-03 build on

- **Profile:** one `GET /booking/user/data` per request, cached for that request only: `name` (and
  `surname` when set), `phone` (turn into `+<digits>`), `email` (sent empty when the profile has
  none, ADR 0009).
- **Create:** the body above, exactly; the answer's `record_id` is the booking id; never read or log
  `record_hash`. A 201 without a positive `record_id` is the fake 201: no booking, say so and give the
  widget link. A 422 with `kind: "required_field"` (a required field named in `meta.errors`) is the
  missing-e-mail fallback; a 403 with code 434 is "contact the business"; 433, 436 and 437 are the
  slot errors of the documented list. HTTP 412 with `X-App-Security-Level` is the anti-fraud path.
- **Move:** `PUT /book_record/{loc}/{record_id}` with `{datetime}` only; the answer is a records-list
  entry, so it can be rendered as `me_list_bookings` does.
- **Cancel:** `DELETE /user/records/{record_id}/0`; 204 with no body.
- **Reading an error:** `meta.errors` is a list or an object keyed by bracketed field names; do not
  assume either.
- **Open:** whether bare-digit phones are refused; how a business that requires an e-mail refuses
  an empty one; the
  anti-fraud answers from the Cloud Run egress (WRITE-07, B3); the cancel and move rules of other
  businesses (the placeholder segment and the `datetime`-only body were seen at 726120 only).
