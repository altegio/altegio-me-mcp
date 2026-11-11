# Changelog

## Unreleased

- `me_book` always sends the `email` key in the create, empty when the client's profile has none
  (ADR 0009): the create route refuses a body without the key whatever the business's
  settings (SUP-506), which turned nearly every first booking from the chat into a question about
  the e-mail. A refusal keyed on the e-mail it sent empty still answers with the `required_field`
  fallback of ADR 0007.

- Adopt MIT with copyright (c) 2026 Altegio, approved by the owner; publication remains a separate decision.

- Move to Node 26 LTS (with Node 24 coverage), npm 12 and compatible TypeScript 6 tooling.
- Migrate to split MCP SDK v2 packages while preserving stateless protocol 2025-11-25.
- Reject untrusted Host headers before authentication and bound concurrent token probes.
- Verify the installed HTTP executable, generated tool inventory, read-only container,
  both supported runtimes and the current release-tool image.
- Correct the public-route probe to require authentication and platform OAuth metadata.
- Add contribution, security and publication guidance. No public release is implied.

## 0.2.0

Existing consumer booking service: business discovery, availability, the client's
places and bookings, and confirmed booking, rescheduling and cancellation.
Booking-form requirements and the marketplace installation gate are supported.
