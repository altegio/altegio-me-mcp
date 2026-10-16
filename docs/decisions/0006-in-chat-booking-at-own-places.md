# ADR 0006: Booking at own places happens in the chat, not in the widget

- Status: accepted
- Date: 2026-10-08
- Deciders: Mike Kondakov (owner)
- Amends: [ADR 0005](0005-own-places-first.md) D3 (the widget was the completion step for own
  places) and [ADR 0001](0001-scope-and-architecture.md) D2 (in-chat booking was product Phase 2)

## Context

Phase 4 delivered the signed-in client: own places, own bookings, the usual service and team
member, and a pre-filled widget link as the last step (ADR 0005 D3). Walking the flow as a
client shows the problem: at a place the client already goes to, the widget is an extra step.
The client is known (the user token), the business already has their name and phone, and the
API creates, moves and cancels a booking for a signed-in client without a confirmation code
(confirmed by the platform owner 2026-10-15: a signed-in client never needs an SMS code for
`book_record`, and a code is never typed into the chat):
`POST /book_record/{loc}` with `Authorization: Bearer <partner>, User <user>`, `PUT
/book_record/{loc}/{record_id}` ("Change Online Booking Date/Time", partner + user), `DELETE
/user/records/{record_id}/{record_hash}` ("record_id is enough to delete the appointment if the
user is authorized"). "Book me with my usual again next Thursday" must end with a booking, not
with a link.

## Decision

**D1. For own places the assistant books in the chat.** Three new tools with the scope
`mcp:me:book`, which the proxy already issues to every signed-in client: `me_book` (create),
`me_reschedule_booking` (move), `me_cancel_booking` (cancel). The client's name and phone come
from their profile (`GET /booking/user/data` with the user token), never from the chat; a tool
input never takes a phone, a name, an e-mail or a code (SEC-02 stays, only its `book_record`
rule is retired for the signed-in client path; partner and anonymous callers still cannot write).

**D2. Every write is two steps.** The first call of `me_book` (and of the reschedule tool)
returns a preview — place, service, team member, time, price, the business's cancellation rule —
and a short confirmation token (HMAC over the preview, 10 minutes). The booking is created only
by a second call that carries the token, after the client said yes. A changed slot invalidates
the token. Cancel takes the booking and a confirmation token issued by the preview of the
cancellation. This is WRITE-02 as planned, and what the directory reviewers expect of a tool
that is not read-only.

**D3. The widget stays for what the API cannot do.** A service that needs prepayment or a
membership (B7), a business whose widget is inactive, or a place where the client has no history
(not an own place): `me_book` says so in band and hands off the pre-filled link (BOOK-02/03,
unchanged). *Amended 2026-10-12 (owner decision): a place where the client has no history is
booked in the chat like an own place. The API creates the booking for a signed-in client at any
business, the client is known by their profile, and "book me at this salon I know" must end with
a booking too. `me_book` reads no client records in the preview, and the `not_own_place` reason is
retired; the other D3 fallbacks stand. Moving and cancelling stay limited to the client's own
bookings.*

**D4. Anti-fraud is tested live before the tools ship.** Server-side `book_record` with a client
token from our egress may meet the anti-fraud paths (HTTP 412 with `X-App-Security-Level`, a
fake 201): the first live run creates and cancels a real booking at the owner's business and
records what happened (WRITE-07, B3 stay open questions if it fails).

**D5. Cases that follow (Phase 5) build on these tools.** Slot hold is "book now, cancel by a
deadline"; two people side by side is two `me_book` calls; freed-slot monitoring ends in
`me_book`. *Amended 2026-10-09 (owner decision after the Phase 5 research): two people side by
side is one `me_book` call with a second appointment — the API creates both appointments of the
signed-in client in one request, atomically, with two different team members; both carry the
client's own name. Slot hold ships only after I8 and a host run that proves an unattended
confirmation; otherwise it is a reminder. Freed-slot monitoring is prompt text on the host's
scheduled tasks with no server state.*

## Consequences

- Phase 4.1 "In-chat Booking at Own Places" (ME-06..ME-09) follows Phase 4 before the cases.
- `mcp:me:book` is granted to the `client` caller kind on the backend; the proxy needs no
  change (altegio-mcp-platform PR #255 already declares and issues it).
- Compliance: the three tools are `readOnlyHint: false`; `me_cancel_booking` is
  `destructiveHint: true`; rule R14 requires `mcp:me:book` on every tool that writes with the user
  token; SEC-02's forbidden-route list keeps `/user/auth`, `/book_code`, `/booking/yplaces` and
  drops `book_record`.
- The booking records the server sends carry no `comment` and no custom fields; reminders use
  the business's defaults (`notify_by_sms` / `notify_by_email` are not set by us).
- The pre-filled widget link remains the completion step for partner callers (known-business
  tools) and for the D3 cases.
