# ADR 0002: Public address on the platform proxy

- Status: accepted
- Date: 2026-10-04
- Deciders: Mike Kondakov
- Amends: [ADR 0001](0001-scope-and-architecture.md) D3 (the domain part only)
- Amended by: [ADR 0003](0003-host-in-platform-project.md) (the GCP project)

## Context

ADR 0001 D3 put the server on its own Cloud Run service with its own domain (candidate
`mcp.altegio.me`). One reason was that the `mcp.alteg.io` proxy admits only Altegio account
holders and has no anonymous lane.

The owner wants the server at the same address family as the other Altegio MCP servers:
`https://mcp.alteg.io/me`, next to `https://mcp.alteg.io/pro`. On `mcp.alteg.io`, every path is
served by the platform proxy (`mcp-proxy`, customer stack, repository `altegio/altegio-mcp-platform`).
That means this address works only through the proxy, not through DNS alone.

What the proxy offers as of 2026-10-04 (`mcp-proxy/README.md`, `stacks/customer/routes.json`):

- Routes are configuration entries. A route can forward to an external https target
  (`target_host`, `target_https`, `target_path`). The internal stack uses this, for example
  for `/giorgio-notion`.
- A request without a token gets 401, so an anonymous route needs a proxy change.
- The usual pattern for a new server is a container on the platform VM behind a route.

## Decision

The public MCP address is **`https://mcp.alteg.io/me`**, served by the platform proxy's customer
stack. The rest of D3 stands: the server runs on our own Cloud Run service in our own GCP project,
deploys only through a Cloud Build trigger on merge to `main`, and keeps its own request logging,
rate limits and abuse protection. The domain `mcp.altegio.me` is dropped.
*Amended 2026-10-04 by [ADR 0003](0003-host-in-platform-project.md): the Cloud Run service runs
in the platform's GCP project `altegio-mcp`, not in a project of its own.*

What the platform team needs to provide:

- A `/me` route on the customer stack that admits requests **without sign-in**: no 401 challenge
  and no protected-resource metadata for this route.
- Forwarding to our Cloud Run service over https.
- The original client IP in a header we can trust, so that our edge limits keep working
  (Anthropic's egress range `160.79.104.0/21` must not collapse into one caller).
- A way for our service to tell that a request came through the proxy, for example the
  platform's existing proxy-origin signature. Direct calls to the `run.app` address must not
  bypass the proxy's controls.

How the route maps to the service: with the route's `endpoint` set to `/mcp`, the address
`https://mcp.alteg.io/me` reaches the service's `/mcp`, as `/pro` does for Altegio.Pro MCP.
Backend paths outside the endpoint, such as `/health`, are not reachable through the short
address. The deployed version is therefore read from `/health` on the `run.app` address, and
uptime through the proxy is checked with an MCP request.

## Consequences

- Phase 3 depends on the platform team, not on DNS. The Search Console and Cloudflare steps for
  `altegio.me` are no longer needed.
- The `mcp.alteg.io` domain matches the Altegio brand, which satisfies Claude's rule that the
  server domain matches the service.
- Every request crosses two Cloud Run hops. The proxy's capacity (10 instances × 80 concurrent
  requests, shared with the Pro customer routes) also bounds our traffic.
- Phase 2 of the product (phone + SMS sign-in, OAuth 2.1) must be designed together with the
  proxy, because the proxy is the OAuth server on `mcp.alteg.io`. ADR 0001's consequence "an
  OAuth authorization server of our own" is reopened for that phase.
- If the platform team cannot add an anonymous lane, fall back to ADR 0001 D3 as written, on a
  domain of our own.

## Research note (2026-10-04)

Phase 3 research read the proxy code in `altegio/altegio-mcp-platform` (`mcp-proxy/server.js`,
`mcp-proxy/lib/backend-auth.js`, `mcp-proxy/lib/dcr.js`). It found that the Context above
assumed too much: the proxy has no lane today that does what `/me` needs, so the route is a
platform code change and not a `routes.json` entry.

- The https target fields (`target_host`, `target_https`, `target_path`) exist only in the
  signed-in auth-inject lane. That lane sits behind the Google sign-in gate, forwards only
  `content-type`, `accept`, `mcp-*` and `last-event-id`, so it carries no client address, and by
  design it never signs a request to an https target (an https target is a third party and must
  never see the proxy-origin header).
- The lanes that do sign speak plain http to a VM backend. The Altegio-token lane answers 401 to
  a request without a token, and the legacy lane needs a Google sign-in.
- Every route must also declare `host`, `port`, `aud` and `scopes`, and the platform's boot test
  lists the customer routes it serves.

So `/me` needs a new proxy lane: anonymous admission (no 401, no protected-resource metadata),
https to our `run.app` host, a per-route opt-in to sign `x-mcp-proxy-auth` (preferably with a key
issued for this route), and the client address in the signed header `x-mcp-auth-client-ip`. The
proxy already strips client-supplied `x-mcp-auth-*` headers and its signature covers every such
header, so the new header is tamper-proof without a change to the signing format. The ask is open
item I5 in [open-questions.md](../open-questions.md), written as a feature request. The platform
may instead prefer our container on its `mcp-customer-servers` VM, which the legacy lane already
signs for; ADR 0003 leaves that choice to them.

Two further points for the ask:

- `/me` must be excluded from the platform's `mcp_proxy_upstream_502` metric in both forms,
  `/me` and `/me/mcp`. The documented filter ends the URL with `/mcp`, so the short form never
  matches it and the long form does.
- The own-domain fallback of ADR 0001 D3 stays deliverable without a code change on our side. It
  is configuration: `PROXY_AUTH=off` (no proxy-origin check) and `TRUSTED_PROXY_HOPS=0` (no proxy
  in front, so no forwarded address is trusted).

## Resolution (2026-10-05)

The anonymous `/me` lane was built by us in `altegio/altegio-mcp-platform` (PR #248, design note
`docs/superflow/specs/2026-10-05-me-anonymous-lane-design.md`) and shipped by the platform owner as
PR #250, which took #248 as its base and added anonymous admission caps, signed request ids and an
operational registry. The customer proxy deployed at 15:35 UTC and `https://mcp.alteg.io/me` passed
the acceptance checks the same day: anonymous `tools/list` answers 200 with the six tools, the
discovery document is 404 in both forms, and an unsigned direct `POST /mcp` on `run.app` answers 401.
The route signs with its own key `MCP_PROXY_BACKEND_KEY_ME`, carries the client address in
`x-mcp-auth-client-ip` and a correlation id in `x-mcp-auth-request-id`, and is outside the VM
autoheal metric, which selects the internal proxy only. The own-domain fallback was not needed.
