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
  the one Pro uses. No copy is made, and a rotation happens in one place. Which developer account
  issued that token is not documented; I3 expects account 2630, and the I6 ask confirms it. The
  owner considered a secret of our own, filled from the local token, and chose not to
  (2026-10-04): it would be a second copy to rotate.
- **Proxy-origin key.** The runtime service account reads the key the proxy signs with
  (`MCP_PROXY_BACKEND_KEY`, or a key the platform issues for this route) in the same project. No
  secret crosses projects.
- **Build pipeline.** The Artifact Registry repo `cloud-run` and the Cloud Build GitHub
  connection already exist. Our repository is linked to that connection.

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
- Neither the trigger nor the service ever runs as a default account of the project. The
  default Compute Engine account in `altegio-mcp` has been granted secret access by the platform,
  so a build or service running as it could read the platform's secrets. The trigger runs as our
  build account, and every deploy passes `--service-account` with our runtime account.
- The platform's autoheal must not react to our errors. Its log-based metric
  `mcp_proxy_upstream_502` counts 502–504 answers on proxied `/<route>/mcp` paths, and alert
  policies on it reset the platform's VMs. Our service is not on a VM, so its errors say nothing
  about them: the `/me` route is to be excluded from that metric, as `/giorgio-notion` and
  `/giorgio-github` are for the same reason (asked with the route, I5). Our own uptime checks and
  alerts cover our service.
- A rotation of `ALTEGIO_API_TOKEN` must reach us. The platform's VM refreshes its copy from
  Secret Manager on every deploy tick (`ops/secret-env-sync.sh`). A Cloud Run instance reads the
  secret when it starts, so if the platform disables the
  old version, our tools fail until the service restarts. Phase 3 picks the fix (re-read the
  secret, or the platform's rotation steps include a redeploy of our service); the alert on
  upstream 401/403 catches a miss.
- We follow the platform's conventions in its project. One-time setup is an idempotent `gcloud`
  script, as the platform does (no Terraform). The monitoring objects we create (uptime checks,
  alert policies, log-based metrics) are added to the platform's `ops/MONITORING.md`.
- Log retention is a project-wide setting owned by the platform. We do not change the `_Default`
  log bucket. The README documents the retention the project has, and the privacy policy (L2)
  cites it. Two more readers of what we log: the platform's logs MCP (`/gcp-logs`) lets staff
  read the project's logs, and the proxy's own request lines for `/me` (route, tool, method) go
  to the platform's BigQuery dataset `mcp_requests` with 90-day partitions. Our logs keep no
  personal data, and the client IP the proxy forwards is never logged in plain form.
- Cost is the same as in the README (about $10–25 a month at the expected load). It is billed to
  `altegio-mcp` and shows up under the label `app=altegio-me-mcp`.
- Being in one project with the proxy makes it possible to close the `run.app` address to
  everything except the proxy (ingress or IAM), on top of the proxy signature. Phase 3 research
  checks what the proxy supports.
- Ownership splits as it does for Pro. The platform team runs the project, the proxy and its own
  monitoring. We own the service: its code, its alerts and its incidents.
- If the platform team declines, fall back to ADR 0001 D3 as written: a project of our own.

## Implementation (Phase 3)

Status of this decision stays accepted. Phase 3 built the setup in the repository; nothing has
been run live yet (the first deploy waits for the platform team, I5 and I6).

- One-time setup: [`scripts/gcp/bootstrap.sh`](../../scripts/gcp/bootstrap.sh), idempotent, with
  `--print` as the review artifact for the platform engineer.
- Deploy pipeline: [`cloudbuild.yaml`](../../cloudbuild.yaml), run by the trigger
  `altegio-me-mcp-deploy` on a merge to `main`. The README table "Deployed settings" is tested
  against it.
- Operations: [`docs/runbooks/gcp-hosting.md`](../runbooks/gcp-hosting.md) (resources, access,
  deploy flow, rollback, rotation, monitoring, drill, known limits, deployment record).

Two findings from building it:

1. **Labels.** The label `app=altegio-me-mcp` named in the table above can be set only on the Cloud
   Run service, the uptime checks and the alert policies. Service accounts, the trigger, the
   repository link, secrets and log-based metrics cannot carry it, so cost by label covers Cloud
   Run only and the other resources are found by name (the runbook lists each).
2. **Registry rights.** `roles/artifactregistry.writer` on the shared repository `cloud-run` is
   repository-wide, so the build account could overwrite another image's tag there. The residual
   risk is held down by the trigger running only on `main` behind the required `test` check, and
   by pushing only the commit-SHA tag. If the platform objects, the fallback is a repository of our
   own.

Two open points of the Consequences list are settled. A rotation of `ALTEGIO_API_TOKEN` reaches
the service without a restart: both secrets are mounted as files and re-read within 60 seconds.
Closing the `run.app` address to everything except the proxy is not possible: internal ingress
admits only callers inside the project's network and an IAM invoker rule needs an ID token the
proxy does not send, so the service runs with `--ingress=all` and relies on the proxy signature
on `/mcp`.
