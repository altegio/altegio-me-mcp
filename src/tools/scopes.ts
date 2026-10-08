// Access tiers (ADR 0004, amended by ADR 0005). A scope names what a caller may
// do, not who it is: every tool declares the scopes it needs, and the call is
// checked against the caller's grant in tools/call only. tools/list is never
// filtered, so every connection to the address sees the same tools; a tool the
// caller cannot run says why when it is called.
//
// Three tiers. mcp:me:discover is the base: every admitted caller (partner
// token, client sign-in, or anonymous while CALLER_AUTH=optional) holds it, and
// the known-business tools need only it. mcp:me:read is the signed-in client's
// own places and bookings: only a client sign-in grants it. mcp:me:book is the
// signed-in client's writes at their own places (ADR 0006): a client sign-in
// grants it, and nobody else.
//
// The names follow the platform's per-service vocabulary (`mcp:pro:read`,
// `mcp:pro:write` on /pro), so the proxy can issue them unchanged when it mints
// OAuth tokens for /me.

/**
 * Base tier: business discovery and the slot check. Every admitted caller
 * holds it. (Until ADR 0005 this tier was called mcp:me:read.)
 */
export const SCOPE_DISCOVER = 'mcp:me:discover' as const;

/**
 * Client tier, read: the signed-in client's own places and bookings. Only a
 * client sign-in grants it.
 */
export const SCOPE_READ = 'mcp:me:read' as const;

/**
 * Client tier, write: the signed-in client's writes at their own places (book,
 * reschedule, cancel; ADR 0006). A client sign-in grants it, with the direct
 * header always and behind the proxy when the signed scope list names it; a
 * partner or an anonymous caller never holds it.
 */
export const SCOPE_BOOK = 'mcp:me:book' as const;

export const SCOPES = [SCOPE_DISCOVER, SCOPE_READ, SCOPE_BOOK] as const;

export type Scope = (typeof SCOPES)[number];

/** The scopes a client sign-in may carry; the proxy's scope list is cut to these. */
export const CLIENT_GRANTABLE_SCOPES: readonly Scope[] = Object.freeze([
  SCOPE_READ,
  SCOPE_BOOK,
]);

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
  if (missing.includes(SCOPE_BOOK) && missing.includes(SCOPE_READ)) {
    return `${tool} books for the signed-in client, and this connection has no client sign-in. Next: tell the user to connect this server with their Altegio sign-in, which happens on the sign-in page and never in the chat, or call book_check for the business's pre-filled booking link; do not retry.`;
  }
  if (missing.includes(SCOPE_BOOK)) {
    return `${tool} books for the signed-in client, and this connection's sign-in does not include booking. Next: tell the user to connect again with booking allowed, or call book_check for the business's pre-filled booking link; do not retry.`;
  }
  if (missing.includes(SCOPE_READ)) {
    return `${tool} reads the signed-in client's own places and bookings, and this connection has no client sign-in. Next: tell the user to connect this server with their Altegio sign-in, which happens on the sign-in page and never in the chat; do not retry.`;
  }
  return `${tool} needs the ${missing.join(', ')} access, which this connection does not have. Next: tell the user the connection needs a valid Altegio partner token; do not retry.`;
}
