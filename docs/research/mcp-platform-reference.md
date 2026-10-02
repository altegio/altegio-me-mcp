# The mcp.alteg.io platform

Research date: 2026-10-02. Source: `altegio/altegio-mcp-platform` (private).

## Summary

A new route on `mcp.alteg.io` is a config entry plus a container, but the customer proxy admits
only Altegio account holders (email + password through its login page, or a raw user token). It
has no anonymous lane and no phone/SMS sign-in. A consumer server would need new proxy code owned
by another team, so this project hosts itself (ADR 0001, D3).

## Architecture

- `mcp-proxy`: Node app on Cloud Run, OAuth 2.1 authorization and resource server, deployed twice:
  `mcp.altegio.dev` for staff (Google, `hd=alteg.io`) and `mcp.alteg.io` for customers (no Google).
- Customer sign-in: the proxy's own email + password page calling `/api/v1/auth`, a stopgap until
  Altegio's own OAuth ("V3"); or a raw user token checked against `/user/roles`.
- DCR (RFC 7591) with a redirect-host allowlist (claude.ai, chatgpt.com, cursor, perplexity, …).
  No CIMD.
- HS256 JWT access tokens (15 min) bound to a route via `aud`, refresh tokens (7 days, rotation),
  PKCE S256 only.
- Upstream headers: `X-Altegio-User-Token`, `x-mcp-auth-scope`, HMAC signature `x-mcp-proxy-auth`.

## Why a consumer route does not fit today

- A request without a token always gets 401 (`server.js`).
- The customer-stack tests require every route to use Altegio sign-in.
- A route outside the Altegio lane would make the stack require Google credentials, which the
  customer stack deliberately lacks.
- The login page accepts only email; validation needs an Altegio user token.
- Each MCP session holds a Cloud Run slot (10 instances × 80); the customer VM is an e2-medium.

## Useful conventions to mirror

- Request log: one line per call with `sub`, `client_id`, `tool`, `rpc_method`, `mcp_client`,
  `token_hash`; never arguments, results or emails. BigQuery, 90-day retention.
- Rate limits on `/register`, `/authorize`, login and `/token`.
- Uptime check per route.
- Evals: `evals/run.py` runs a Claude agent against live endpoints with YAML tasks
  (`prompt`, `success_regexes`, `expected_tools`, `forbidden_tools`). The task format is reusable.

## Contacts

Slack `#altegio-mcp-platform`, `#mcp-auth-migration`, `#dev-public-mcp`. No CODEOWNERS;
ownership in `docs/infrastructure.md`.
