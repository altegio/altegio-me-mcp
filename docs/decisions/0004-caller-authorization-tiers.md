# ADR 0004: Caller authorization: a partner token first, OAuth for client actions

- Status: accepted
- Date: 2026-10-06
- Deciders: ypetrou (y@alteg.io)
- Amends: [ADR 0001](0001-scope-and-architecture.md) (Phase 1 is no longer anonymous) and
  [ADR 0002](0002-public-address-on-platform-proxy.md) (the `/me` lane admits partner tokens, not
  anonymous callers)

## Context

Since 2026-10-05 `https://mcp.alteg.io/me` is anonymous: anyone may call it, and every upstream
call goes out with the token of developer account 2630, whose per-partner budget is shared with
the platform's marketplace confirmations. Nothing tells callers apart except their address.

The Altegio REST API itself never serves an anonymous call: every request carries a partner
token, and calls made for one person add that person's user token
(`Authorization: Bearer <partner>, User <user>`). Altegio.Pro MCP mirrors this: the proxy admits a
raw Altegio user token or an OAuth token from the Altegio sign-in, and a caller that is itself an
Altegio application may send its own partner token per request (Pro "UC2",
`X-Altegio-Partner-Token`).

The goal: no call without a credential. The base credential is a partner token; actions for one
client (booking in chat, Phase 2) need that client's OAuth sign-in on top.

## Research (2026-10-06)

| Source | What it settles |
|---|---|
| [MCP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | Authorization is optional; when used, the server is an OAuth 2.1 resource server with protected-resource metadata (RFC 9728). A 401 names `resource_metadata` and the `scope` to request; a 403 `insufficient_scope` at run time starts a step-up, and the client asks for the union of old and new scopes. "MCP servers MUST NOT accept or transit any other tokens." Client ID Metadata Documents are preferred, dynamic registration is deprecated. |
| [OAuth client credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials) (SEP-1046) | Machine-to-machine access without a user: `client_credentials` with a secret or a signed JWT assertion. Opt-in; client support varies. |
| [OpenAI Apps SDK, authentication](https://developers.openai.com/apps-sdk/build/auth) | Per-tool `securitySchemes` (`noauth`, `oauth2` with scopes), and `_meta["mcp/www_authenticate"]` on an error result to start account linking for one tool. Mixed anonymous and signed-in tools on one server. |
| Claude hosts ([claudeissues #68720](https://claudeissues.com/issue/68720-bug-mcp-403-insufficient-scope-step-up-authorization-is-dropped-and-misreported), [#19066](https://claudeissues.com/issue/19066-bug-claude-code-doesnt-use-scope-from-www-authenticate-during-step-up-authorizat)) | A 403 `insufficient_scope` step-up is not handled reliably yet: the challenged scope is dropped or the error is shown as an expired token. |
| [Stripe MCP](https://edge-docs.stripe.com/mcp) | OAuth for interactive hosts, and a restricted API key as the Bearer for agents that do not speak OAuth. |
| [GitHub MCP server](https://github.blog/changelog/2026-01-28-github-mcp-server-new-projects-tools-oauth-scope-filtering-and-new-features/) | Local: tools filtered by the PAT's scopes. Remote: a middleware answers a tool call that needs more with a 403 scope challenge; it has to parse the JSON-RPC body itself. |
| [FastMCP 3](https://gofastmcp.com/servers/authorization) | Per-tool `auth=require_scopes(...)`, checked on the call and used to filter `tools/list`. |
| [WorkOS, 2026-09-01](https://workos.com/blog/mcp-scope-step-up-vs-authentication-step-up) | Scope step-up is not authentication step-up: MCP has no `acr_values`/`max_age` (RFC 9470); fresh-login requirements need an out-of-band confirmation. |

The common shape: a gateway or authorization server authenticates; the server authorizes each
tool by scope; headless agents may present an API key as the Bearer next to OAuth for people.

## Decision

**D1. Base tier: the caller's own Altegio partner token.** The token of a developer account in
the Altegio marketplace, sent as `Authorization: Bearer <token>` (or `X-Altegio-Partner-Token`).
It grants the scope `mcp:me:read`, which every current tool needs. There is no anonymous call.

*2026-10-12: an anonymous tier was reopened for a few hours (release 14, PR #23) on a misreading
of the platform owner's 2026-10-09 note and closed again the same day (release 15): the partner
token is always required, as #252 established; "without authorization" in that note meant
without the client's SMS sign-in, with a partner token present. A headless caller reads with its
partner token and needs no SMS; an interactive host (claude.ai) has no partner token, so its
client signs in by SMS first (D4, platform PR #255), a long-lived session.*

*Amended 2026-10-08 (ADR 0005, Phase 4): the base scope is `mcp:me:discover`; `mcp:me:read` is the
signed-in client's read scope.*

*Amended 2026-10-08 (ADR 0006, Phase 4.1): `mcp:me:book` is granted with a client sign-in; the three
write tools require it.*

**D2. Altegio decides whether a token is valid.** A token is valid when Altegio accepts it on
`GET /companies?count=1&page=1`, a call that names no business and answers 401 for an unknown
token (checked live on 2026-10-06 with a real and a made-up token). Verdicts are cached by the
SHA-256 of the token: valid for 5 minutes, invalid for 30 seconds; an Altegio failure is never
cached and answers 503 with `Retry-After: 5`. A token that is not 8 to 512 printable characters
is refused without a probe. The check lives in this server, not in the proxy: the server owns the
partner semantics, behaves the same behind the proxy and on an own domain, and needs the token
anyway (D3). The proxy only requires a credential and forwards it signed.

**D3. Upstream calls use the caller's token,** as Pro's UC2 does. Altegio then applies its
per-partner limits, anti-fraud rules and attribution to that partner, and partners no longer
spend account 2630's shared budget. A 401 or 403 on the caller's token is the caller's to fix: it
is never retried with our token, and the tool error says the connection's token was refused. A
429 on the caller's token is answered with the advised wait and pauses nobody else: one partner
exhausting its budget never slows another. The
process-wide request gate stays, because all partners share our egress address and its per-address
limit; its numbers were sized for the 2630 budget and are revisited once partner traffic is
measured.

**D4. Client tier: OAuth 2.1 for actions on one client's behalf (Phase 2).** The platform proxy,
the authorization server on `mcp.alteg.io`, signs the client in by phone and SMS code
(`/user/auth`), keeps the Altegio user token encrypted as it does for Pro, and forwards it
signed. Tools that act for a client need `mcp:me:book`; a partner token never grants it.
Compliance rule R14 makes every writing tool require it.

**D5. Who enforces what.** The proxy authenticates (no credential, 401). This server checks the
partner token (D2) and authorizes each tool in `tools/call` against its declared scopes; the
refusal is an in-band `isError` result, and `tools/list` is the same for every caller, as in Pro.
When `/me` gets OAuth, the refusal adds `_meta["mcp/www_authenticate"]` and the proxy serves
protected-resource metadata; an HTTP 403 `insufficient_scope` waits until hosts handle it. The
client-credentials extension is a later, standard way to obtain the base tier.

**D6. Interactive hosts wait for Phase 2.** claude.ai, ChatGPT and the connector directories
cannot present a partner token, so they cannot use `/me` until D4 ships, and directory
submission moves to Phase 2. Agents built by partners (Claude API, Agent SDK, OpenAI Responses,
their own clients) send the token as a header today.

**D7. Defense in depth.** With `CALLER_AUTH=required` (the default) this server refuses a call
without a valid partner token itself, so an anonymous proxy route could not reopen it. Behind the
proxy only the signed header `x-mcp-auth-altegio-partner-token` counts: the proxy signature covers
every `x-mcp-auth-*` header, and the `run.app` address is public, so any unsigned header is the
sender's to choose.

### Header contract with the proxy

| Hop | Headers |
|---|---|
| Caller to proxy | `Authorization: Bearer <partner token>` or `X-Altegio-Partner-Token: <partner token>` |
| Proxy, no credential | 401, `WWW-Authenticate: Bearer realm="mcp.alteg.io", error="invalid_token", error_description="Send your Altegio partner token ..."`, no `resource_metadata` until `/me` has OAuth (a host would otherwise start a sign-in that cannot finish) |
| Proxy to this server, signed | `x-mcp-auth-kind: partner`, `x-mcp-auth-altegio-partner-token`, `x-mcp-auth-client-ip`, `x-mcp-auth-request-id`; never `Authorization` |
| This server, no or bad token | 401 `partner_token_required` (`WWW-Authenticate: Bearer realm="altegio-me"`) or 401 `invalid_token`; 503 `temporarily_unavailable` when Altegio cannot say |

### Rollout

1. This server ships with `CALLER_AUTH=optional` in `cloudbuild.yaml`: anonymous calls behave as
   before, and a signed partner token, when present, is checked and used.
2. The platform proxy's `/me` lane requires a partner token and forwards it signed (pull request
   in `altegio/altegio-mcp-platform`).
3. The platform monitor (`altegio-monitoring`) expects 401 from an anonymous `/me` probe and sends
   a partner token with its canary.
4. `cloudbuild.yaml` switches to `CALLER_AUTH=required`.

Rollback is the reverse order: step 4 first, then step 2.

All four steps shipped on 2026-10-06 (altegio-me-mcp #11, altegio-mcp-platform #252,
altegio-monitoring #44, then this server's switch); the release log in
[the GCP hosting runbook](../runbooks/gcp-hosting.md) records each one.

## Consequences

- Partners register a developer account; the API licence binds them (client consent, GDPR).
- The first call of a partner in any 5 minutes costs one probe on its own budget (0.3 to 1 s
  measured).
- The partner token passes through this server: it is never logged (the call log carries
  `partner_id`, the first 16 hex digits of its SHA-256, the same pseudonym as the proxy's
  `token_hash`) and is scrubbed from tool results and upstream messages.
- Accepting a partner API key as the Bearer departs from the MCP rule that a server accepts only
  tokens from its own authorization server, as Pro's raw user tokens and Stripe's restricted keys
  do. The OAuth path of D4 follows the specification.
- `ALTEGIO_API_TOKEN` (account 2630) stays required: `CALLER_AUTH=optional`, the live suite and
  the catalog job of a later phase use it.
