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
