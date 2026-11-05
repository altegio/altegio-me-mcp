# Changelog

## Unreleased

- Move to Node 26 LTS (with Node 24 coverage), npm 12 and compatible TypeScript 6 tooling.
- Migrate to split MCP SDK v2 packages while preserving stateless protocol 2025-11-25.
- Reject untrusted Host headers before authentication and bound concurrent token probes.
- Verify the installed HTTP executable, generated tool inventory, read-only container,
  both supported runtimes and the current release-tool image.
- Add contribution, security and publication guidance. No public release is implied.

## 0.2.0

Existing consumer booking service: business discovery, availability, the client's
places and bookings, and confirmed booking, rescheduling and cancellation.
Booking-form requirements and the marketplace installation gate are supported.
