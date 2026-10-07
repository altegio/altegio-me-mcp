// Access tiers (ADR 0004). A scope names what a caller may do, not who it is:
// every tool declares the scopes it needs, and the call is checked against the
// caller's grant in tools/call only. tools/list is never filtered, so every
// connection to the address sees the same tools; a tool the caller cannot run
// says why when it is called.
//
// The names follow the platform's per-service vocabulary (`mcp:pro:read`,
// `mcp:pro:write` on /pro), so the proxy can issue them unchanged once it
// mints OAuth tokens for /me.

/** Base tier: business discovery and the slot check. Any partner token grants it. */
export const SCOPE_READ = 'mcp:me:read' as const;

/**
 * Client tier: acting for one signed-in client (book, reschedule, cancel, list
 * their bookings). Only an OAuth token from the client's phone sign-in grants
 * it; no tool needs it yet.
 */
export const SCOPE_BOOK = 'mcp:me:book' as const;

export const SCOPES = [SCOPE_READ, SCOPE_BOOK] as const;

export type Scope = (typeof SCOPES)[number];

/** The scopes a grant lacks for a tool, in the tool's own order. */
export function missingScopes(
  required: readonly Scope[],
  granted: ReadonlySet<Scope>
): Scope[] {
  return required.filter((scope) => !granted.has(scope));
}

/**
 * The in-band refusal of a call the grant does not cover. In-band, as in
 * Altegio.Pro MCP: an isError result reaches the model with the reason, where
 * an HTTP 403 insufficient_scope is not yet handled by every host (Claude
 * reports it as an expired token). The OAuth step-up challenge
 * (`_meta["mcp/www_authenticate"]`) is added once the proxy issues /me tokens.
 */
export function scopeRefusalText(
  tool: string,
  missing: readonly Scope[]
): string {
  const needsClient = missing.includes(SCOPE_BOOK);
  return needsClient
    ? `${tool} acts for a signed-in client, and this connection has no client sign-in. Next: tell the user this step is done in the business's booking widget; do not retry.`
    : `${tool} needs the ${missing.join(', ')} access, which this connection does not have. Next: tell the user the connection needs a valid Altegio partner token; do not retry.`;
}
