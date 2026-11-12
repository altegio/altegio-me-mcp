# ADR 0009: The create always sends the email key, empty when the profile has none

- Status: accepted (the live check below booked with an empty e-mail, 2026-11-09)
- Date: 2026-11-09
- Deciders: ivan.k (raised in review of PR #29/#30)
- Amends: [ADR 0006](0006-in-chat-booking-at-own-places.md) D-02 (the create sends the profile's
  e-mail only when it has one) and narrows [ADR 0007](0007-email-in-chat-when-required.md) to the
  businesses that really require an e-mail

## Context

`POST /book_record/{location_id}` answers HTTP 422 `{"[email]": ["The required parameter email was
not passed."]}` when the body has no `email` key, whatever the business's online-booking settings
say about the e-mail field. This is a known API bug: Jira SUP-506 (2024-08-16, still in Research);
the API documentation calls `email` optional. Both live `required_field` refusals so far (locations
1389064 and 1313947) came from businesses whose booking form does not require an e-mail.

Until now the server sent `email` only when the profile had a non-empty one and never sent the key
empty ([signed-in-routes.md](../research/signed-in-routes.md), "Required e-mail"). That was a
choice made before SUP-506 was known, not an observation: an empty `email` was never tried.

The scale makes the bug the common case, not an edge one. From BI, since August: 98.8 % of active
Altegio.me users (422k of 428k) have no e-mail in their profile, while 12.8 % of active locations
(1,683 of 13,178) require one. So nearly every client's first booking from the chat would end in
the ADR 0007 question about the e-mail, at businesses that do not need it.

The business's booking widget always sends the `email` key, empty when the client gave none, and
its bookings go through.

## Decision

- The create body always carries `email`: the profile's when it has one, the client's from the
  chat when ADR 0007 applies, and `""` otherwise. Nothing else in the body changes.
- ADR 0007 stays for real refusals: a business that requires an e-mail refuses the empty one, the
  answer is the `required_field` fallback naming `email`, and the client may give it in the chat.
- Because the wording of the refusal of an empty e-mail is not observed yet, a 422 with no code
  that keys an error on `email` counts as a missing e-mail whenever the create sent it empty,
  whatever the message says (`UpstreamError.fieldErrors`). A refusal of an e-mail that was sent
  non-empty keeps its current handling.

## Live check

Run on 2026-11-09 at the test location 1389064, whose booking form does not require an e-mail,
with a partner token only (no client sign-in), a fictitious client and one free slot confirmed by
`book_check` first:

| Body | Answer |
| --- | --- |
| no `email` key (control) | HTTP 422, `meta.errors` `{"email": ["The required parameter email was not passed."]}`, no code; nothing created |
| `"email": ""` | HTTP 201, record 682034179; cancelled at once by `DELETE /user/records/{id}/{record_hash}` (204), seen deleted in the BI replica |

The refusal is the same with and without a client sign-in (the earlier ones carried the user
token), so the check stands for `me_book`. The same check through the opt-in live suite, with a
client sign-in:

```bash
ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_WRITE_EMPTY_EMAIL=1 \
  ALTEGIO_E2E_WRITE_LOCATION=722227 \
  node --env-file=.env ./node_modules/jest/bin/jest.js \
  --testPathPatterns=user-writes.live --runInBand
```

Pass: `statuses.create` is 201, `record_id_present` true, `email_sent` false, and the booking is
seen cancelled. Still open: the wording of the refusal of an empty e-mail at a business that
requires one (the classification above does not depend on it).

## An e-mail given with a booking is not kept in the profile

Observed in the BI replica on 2026-11-09 for the bookings 680818915, 680820382 and 680822575
(location 1389064, 2026-11-02, created through this server with an e-mail in the body, since the
profile had none and the route refuses a body without the key): the business's client card,
created with the first of them, holds an e-mail; the client's Altegio.me profile (`booking_users`)
still has none and was last updated in May 2026. So the e-mail of a booking goes to that business's
client card only, and the ADR 0007 question comes again at each new business that requires an
e-mail.

## Consequences

- Clients without a profile e-mail book in the chat at the 87 % of businesses that do not require
  one, with no question about the e-mail.
- The 422 classification of the create gains one field-name list; messages are still never kept.
