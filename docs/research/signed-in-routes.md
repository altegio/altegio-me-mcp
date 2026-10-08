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
