# ADR 0008: The booking form's custom fields, enforced at the preview and answered in the chat

- Status: accepted
- Date: 2026-11-02
- Deciders: ivan.k (found the hole and accepted the design in the session that shipped PR #31)
- Amends: [ADR 0006](0006-in-chat-booking-at-own-places.md) D-02 (what the create sends) and
  extends [ADR 0007](0007-email-in-chat-when-required.md) to the form's own questions

## Context

A business can add custom fields to its booking form (select, date, text, number, checkbox) and
mark them required: the widget does not submit without them. The create route does not enforce
them — `POST /book_record` accepted a booking with the required "Floor" and "Return" fields of
location 1389064 empty (bookings 680818915, 680820382, 680822575, 2026-11-02). Every API
integration bypasses them the same way; the chat should not.

Two upstream facts make the fix possible:

- `GET /booking/forms/{form_id}/custom_fields/` (partner token) returns the widget's field config:
  `code`, `title`, `type`, `is_required`, `values` (the select options). The form id is in the
  business card's `bookforms`.
- `POST /book_record` takes the answers as `appointments[].custom_fields`, a key–value object by
  field `code` (documented in the online-booking spec).

## Decision

`me_book` reads the booking form's custom fields at the preview and enforces them:

- **Enforced before the client confirms anything.** A preview at a business whose form has
  required fields this call did not answer returns the `required_field` fallback at once — no
  token, no `book_check` — with `missing_fields` (the codes) and `form_fields` (every field's
  code, title, type, required flag and allowed values, sanitized as third-party text). The
  assistant asks the client the questions and calls again with `custom_fields`.
- **Answers are validated, not guessed.** `custom_fields` is keyed by field code; a code the form
  does not have and a select answer outside the allowed values are refused in band. The input
  description tells the assistant to ask the client, never to guess.
- **Bound to the preview.** `custom_fields` is part of the token's bound arguments, and the
  preview names the answered codes (`preview.form_answers_included`), so what the client confirmed
  is what the create sends — on both appointments of a pair.
- **Sent once, to one business.** The answers go into that one create body. They are not logged
  (the fixed log key set is unchanged), not stored, and no tool returns the values.
- **Fail closed on the config read.** A form the card names but whose fields cannot be read right
  now refuses the preview with a retry advice, because booking past an unreadable config would
  recreate the hole. The one exception is a 404 — a form the route does not know (deleted or
  replaced) has no config to enforce, so the booking runs as before.

## Consequences

- One more upstream GET per `me_book` preview (only for businesses whose card names a form).
- The widget remains the path for what the chat still cannot collect: the consent checkbox wording
  and any future field kind whose semantics the API does not expose.
- `comment_required` (the booking form's comment toggle) stays out: ADR 0006 deliberately sends no
  comment, and a required comment therefore still falls back to the widget — a known, separate
  gap.
- The journal shows the chat's answers exactly as the widget's: the create stores them on the
  record.
