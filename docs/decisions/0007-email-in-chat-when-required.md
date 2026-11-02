# ADR 0007: The client's e-mail in the chat, only where a business requires it

- Status: accepted
- Date: 2026-11-02
- Deciders: ivan.k (requested and accepted in the working session that shipped PR #29/#30)
- Amends: [ADR 0006](0006-in-chat-booking-at-own-places.md) D-02 (the create sends only what the
  profile holds) and the server instructions sentence that the tools take no client e-mail

## Context

The tools have never taken the client's name, phone or e-mail in the chat: the create call sends
what the client's Altegio profile holds, and personal data stays out of the AI hosts' logs. That
held until the first live `required_field` case (location 1389064, 2026-11-02): a business whose
booking form requires an e-mail refuses the create with a keyed 422 when the profile has none, and
the chat could only hand over the widget link. PR #29 made the refusal name the missing fields
(`fallback.missing_fields`), so the assistant can say what is missing — but the client still could
not complete the booking in the chat, and Altegio.me has no profile-edit surface the assistant
could point to with one tap.

## Decision

`me_book` takes an optional `email` argument, under these rules:

- **Purpose-bound.** It exists for the `required_field` fallback that names `email`. The input
  description and the fallback text both say to ask the client for it; the assistant never guesses
  it or fills it from anywhere else.
- **Bound to the preview.** The e-mail is part of the token's bound arguments: it cannot be added
  at the confirm call. The flow is fallback → ask the client → new preview with `email` → the
  client confirms a preview that states an e-mail will be sent (`preview.email_included`, a
  boolean; the address itself is never returned).
- **Sent once, to one business.** When given, it is sent in place of the profile's e-mail in that
  one create body, to that one business. The server keeps nothing of it: it is not logged (the
  structured log's fixed key set is unchanged), not stored, and no tool returns it.
- **The second person stays out.** `second_appointment` still takes no name, phone or e-mail;
  both bookings of a pair are under the signed-in client.

## Consequences

- The client's e-mail now passes through the AI host's context when the client chooses to give it
  there. That is the client's own choice about their own address, made after the business refused
  the booking without it; the alternative (the widget link) remains in the same answer.
- The server instructions and README no longer claim that no tool takes the e-mail; they state the
  one exception and its bounds.
- The upstream create already accepted an `email` field (the profile's, when it had one), so no
  upstream contract changed.
- The profile itself is not updated: whether Altegio keeps the e-mail from a booking is the
  platform's behaviour, not this server's. A later `required_field` at another business asks
  again unless the profile gained the address meanwhile.
