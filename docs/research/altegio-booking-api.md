# Altegio public booking API (B2C)

Research date: 2026-10-02. Sources: `altegio/biz.erp.api.docs` (`docs/en/public/openapi.yaml`,
live at https://developer.alteg.io/en/public/openapi), the booking widget `altegio/client.booking`,
backend code in `altegio/biz.erp` (read via code search). No live API calls were made; behaviour
taken from backend code is marked "(code)".

## Conventions

- Base URL `https://api.alteg.io/api/v1`, header `Accept: application/vnd.api.v2+json`.
- Auth column: **P** = `Authorization: Bearer <partner_token>`; **P+U** =
  `Authorization: Bearer <partner_token>, User <user_token>`.
- `{loc}` is the location (company) id.

## Booking flow

| Method | Path | Auth | Purpose and key params |
|---|---|---|---|
| GET | `/bookform/{id}`, `/bookform/hostname/{host}` (undocumented) | P | Booking form settings: steps, `phone_confirmation`, `group_id` (chain), languages |
| GET | `/company/{id}?forBooking=1&showBookforms=1&bookform_id=` | P | Business card, next free slot, booking form URLs |
| GET | `/book_services/{loc}` | P | `staff_id`, `datetime`, `service_ids[]`. Only services enabled for online booking, price min/max, `prepaid` |
| GET | `/book_staff/{loc}` | P | `service_ids[]`, `datetime` |
| GET | `/book_dates/{loc}` | P | `service_ids[]`, `staff_id`, `date` or `date_from` + `date_to` |
| GET | `/book_times/{loc}/{staff_id or 0}/{date}` | P | `service_ids[]`. Returns the `datetime` to book with |
| GET | `/book_staff_seances/{loc}/{staff_id}` | P | Nearest free slots |
| POST | `/book_check/{loc}` | P | Validates `appointments[]`. Empty 201 means bookable |
| POST | `/book_code/{loc}` | P | Sends a confirmation code: `phone`, `fullname` |
| POST | `/book_record/{loc}` | P, or P+U to skip the code | `phone`, `fullname`, `email`, `code` (only if the business requires phone confirmation), `appointments[{id, services[], staff_id, datetime, custom_fields}]`, `comment`, `notify_by_sms`, `notify_by_email`, `api_id`. Returns `record_id`, `record_hash`, and a `user_token` once the phone is confirmed. Errors 431–437: bad code, slot taken, client blacklisted, etc. |
| GET | `/book_record/{loc}/{rid}/{hash}` | P with hash, or P+U | Booking details |
| PUT | `/book_record/{loc}/{rid}[/{hash}]` | P+U (code also accepts the hash) | Reschedule: `datetime`, `comment` |
| DELETE | `/user/records/{rid}/{hash}` | P with hash, or P+U | Cancel, within the business's cancellation rules |
| GET | `/user/records` (undocumented), `/user/records/{rid}/{hash}` | P+U | The client's bookings |
| POST | `/user/auth` | P | `phone`, `code`, optional `company_id` → `user_token` |
| POST | `/booking/auth` | P | Legacy login + password sign-in |
| GET, PUT | `/booking/user/data`, `/booking/user` | P+U | Client profile |
| GET | `/activity/{loc}/search`, `/search_dates`, `/search_dates_range`, `/filters` | P | Group events |
| POST | `/activity/{loc}/{event_id}/book` | P | `fullname`, `phone`, `email`, `code`, `clients_count` |
| GET | `/user/loyalty/abonements`, `/certificates`, `/cashback`; `/user/loyalty_cards/{chain}/{loc}` | P+U | Memberships and loyalty (undocumented) |
| POST | `/booking/locations/{loc}/attendances/calculate` | P | Undocumented. Per-service price, prepayment status (`required`, `forbidden`, …), `is_subscription_only` |
| GET | `/countries`, `/cities?country_id=`, `/privacy_policy/{loc}`, `/i18n/{lang}` | P | Reference data |

- **Newer widget API:** the widget also calls `POST /booking/search/{services,staff,dates,timeslots}`
  and `/booking/locations/{loc}/attendances`. They exist in the backend but have no public docs
  or contract.
- **Prepayment (code):** send `is_support_charge=true`, `appointments_charges[]` and `redirect_url`
  to `book_record`. The response includes `charge.url`, a hosted payment page.

## Discovery

- **There is no search API.** `GET /companies` with a partner token returns every active business
  in the network ordered by id, `count` up to 1000. Filters: `city_id`, `business_group_id`,
  `business_type_id`, `group_id`, `forBooking`. No text search, no geo or radius, no opt-in flag
  (the only opt-in-style filter is `yandex`, for the Yandex Maps integration). These calls are
  logged as "suspicious search params" and limited to 100 requests per 10 s
  (code: `PageApiCompaniesReadController.php`).
- **Altegio.me is not a catalog.** `GET /user/companies/yplaces` returns only businesses where the
  phone already has bookings and that installed the Altegio.me marketplace app
  (code: `YplacesAvailabilityService.php`).
- **v3 (preview)** has `/reference/cities`, `/reference/business_types`, `/locations`, but locations
  are limited to what the credential can access. Nothing B2C.

## End-client sign-in (phone code)

- **Per-business code:** `POST /book_code/{loc}`. Sent through the business's own SMS, only if
  the business has SMS enabled. `GET /book_code/{loc}/channel` shows the channel. Spam or fraud
  checks can return a fake 201 and send nothing (code). Next step: pass `code` to `book_record`,
  or call `POST /user/auth` for a `user_token`. The token belongs to one client identity across
  the network, created on first sign-in.
- **Network-wide code (undocumented):** `POST /booking/yplaces/code` then `/booking/yplaces/auth`.
  Used by Altegio.me. Altegio pays for the messages. Silently sends nothing if the phone is not
  in any business's client list.
- **Without confirmation:** if the business does not require phone confirmation, `book_record`
  accepts any name and phone.

## Partner tokens, limits, terms

- **Token:** register a developer account at https://app.alteg.io/appstore/developers/1; the
  partner token appears under account settings.
- **No per-business install for B2C:** the `book_*` code checks no partner installation.
- **Limits:** docs say 200 requests/min and 5 requests/s per IP. Code adds a per-partner limit on
  booking routes (60 s window, configurable per partner) and IP limits on `book_code` unless the
  partner is in `SPAM_EXCLUDED_PARTNER_IDS`.
- **Anti-fraud on `book_record` (code):** can return 412 with `X-App-Security-Level` (reCAPTCHA v3
  or a captcha page), or a fake 201 marked with a fraud header. Behaviour is keyed on partner
  types (`widget`, `google_maps`, `general_client_app`, …).
- **Terms:** limited, revocable licence; the partner must obtain client consent and comply with
  GDPR (`docs/en/api-license-agreement.md`).

## Deep links

- **Hosts:** `https://n{formId}.alteg.io` or `https://b{formId}.alteg.io`; personal subdomains
  `{slug}.altegio.me` and `{slug}.rsrv.ws`; `o{id}.alteg.io` is the online sales form for
  memberships and certificates. Get the form URL from `GET /company/{id}?showBookforms=1`.
- **Paths:** `/company/{loc}/personal/select-services`, `/select-master`, `/select-time`,
  `/company/{loc}/create-record` (confirm step).
- **Pre-selection:** `?o=m{staffId}s{serviceId}[,…]d{YYDDMMHHmm}`; group events use
  `aid{eventId}c{seats}` and `act{YYYY-MM-DD}` (`libs/utils/.../map-url-to-record.ts` in
  `client.booking`). Format taken from code; verify in a browser before relying on it.
- **Payment hand-off:** `charge.url` from `book_record`.

## Regions

YCLIENTS runs the same code base and v1 paths at `api.yclients.com/api/v1`, as a separate
deployment with separate partner tokens and data (YPLACES is its Altegio.me). Languages come from
`/i18n/{lang}` and the form's `langs`. Currency is per business. Kazakhstan adds an optional
`national_id` field.
