# ADR 0003: Host in the platform's GCP project

- Status: accepted
- Date: 2026-10-04
- Deciders: Mike Kondakov
- Amends: [ADR 0001](0001-scope-and-architecture.md) D3 and
  [ADR 0002](0002-public-address-on-platform-proxy.md) (the GCP project only)

## Context

ADR 0001 D3 and ADR 0002 kept the server in a GCP project of its own, `altegio-me-mcp`. That
project came from two places: Altegio services that are not MCP servers each have a project of
their own (for example `ops-kommo-tusker`), and D3 first assumed the server would live apart from
the platform. ADR 0002 removed that assumption: the public address is a route on the platform
proxy.

Every Altegio MCP server behind the platform proxy lives in one GCP project, `altegio-mcp`
(`altegio/altegio-mcp-platform`, checked 2026-10-04):

- Both proxies run on Cloud Run: `mcp-proxy` (`mcp.alteg.io`) and `mcp-proxy-internal`
  (`mcp.altegio.dev`).
- Every backend is a container on one of two VMs: `mcp-servers` (internal routes) or
  `mcp-customer-servers` (`/pro`, `/integrations-hub`, `/knowledge`).

No Altegio MCP server has a project of its own. A project of our own would give admin rights
without asking, a separate bill and quotas, and isolation. None of that weighs much here: we
depend on the platform team for the route anyway, the partner token is already shared with
Altegio.Pro MCP (I3), and resource labels give a separate cost line. Company policy asks for GCP,
Cloud Run, a Cloud Build trigger and Secret Manager. It does not ask for a project per service.

## Decision

The server runs as its own Cloud Run service `altegio-me-mcp` in the platform's project
`altegio-mcp`, region `europe-west1`. Project `altegio-me-mcp` is not created. Everything else in
D3 and ADR 0002 stands:

- deploys only through a Cloud Build trigger on merge to `main`;
- the public address `https://mcp.alteg.io/me` through the platform proxy;
- request logging, rate limits and abuse protection are ours to build.

It is a Cloud Run service, not a container on `mcp-customer-servers` next to Pro. The server takes
anonymous public traffic. On Cloud Run a spike or an abuse wave scales and fails on its own,
away from Pro, Integrations Hub and Knowledge on the shared e2-medium VM. Cloud Run also keeps the
company rule of deploying through a Cloud Build trigger. The platform team may still prefer the
VM; the ask (I6) leaves that choice to them.

What the shared project gives us:

- **Partner token.** The runtime service account reads the existing secret `ALTEGIO_API_TOKEN`,
  the one Pro uses (account 2630, I3). No copy is made, and a rotation happens in one place.
- **Proxy-origin key.** The runtime service account reads the key the proxy signs with
  (`MCP_PROXY_BACKEND_KEY`, or a key the platform issues for this route) in the same project. No
  secret crosses projects.
- **Build pipeline.** The Artifact Registry repo `cloud-run` and the Cloud Build GitHub
  connection already exist. Our repository is linked to that connection.
- **Proxy-side monitoring.** The platform's metric on upstream errors (`mcp_proxy_upstream_502`)
  counts the `/me` route too.

Resource names:

| Resource | Name |
|---|---|
| Cloud Run service | `altegio-me-mcp` |
| Image | `europe-west1-docker.pkg.dev/altegio-mcp/cloud-run/altegio-me-mcp` |
| Runtime service account | `altegio-me-mcp-runtime@altegio-mcp.iam.gserviceaccount.com` |
| Cloud Build trigger | `altegio-me-mcp-deploy`, running `/cloudbuild.yaml` |
| Label on every resource | `app=altegio-me-mcp` |

## Consequences

- Setup needs the platform team, not organization admins. The asks (I6): rights in `altegio-mcp`
  for the owner to run the one-time setup script (or a platform engineer runs it), our
  repository linked to the Cloud Build GitHub connection, and runtime access to the two secrets.
  No new project, billing link or organization-level GitHub connection.
- Our IAM in `altegio-mcp` stays narrow. The runtime account reads only its two secrets. The
  build account deploys only our service. The setup script never changes project-wide settings
  or other services' IAM, so a mistake on our side cannot reach the proxy or the VMs.
- We follow the platform's conventions in its project. One-time setup is an idempotent `gcloud`
  script, as the platform does (no Terraform). The monitoring objects we create (uptime checks,
  alert policies, log-based metrics) are added to the platform's `ops/MONITORING.md`.
- Log retention is a project-wide setting owned by the platform. We do not change the `_Default`
  log bucket. The README documents the retention the project has, and the privacy policy (L2)
  cites it.
- Cost is the same as in the README (about $10–25 a month at the expected load). It is billed to
  `altegio-mcp` and shows up under the label `app=altegio-me-mcp`.
- Being in one project with the proxy makes it possible to close the `run.app` address to
  everything except the proxy (ingress or IAM), on top of the proxy signature. Phase 3 research
  checks what the proxy supports.
- Ownership splits as it does for Pro. The platform team runs the project, the proxy and its own
  monitoring. We own the service: its code, its alerts and its incidents.
- If the platform team declines, fall back to ADR 0001 D3 as written: a project of our own.
