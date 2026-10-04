# Infrastructure, mirrored from Altegio.Pro MCP (I1-I3)

Research date: 2026-10-03. Answers open questions I1-I3 from how Altegio.Pro MCP and the
`mcp.alteg.io` platform are set up, at the owner's request. Sources: `altegio/altegio-pro-mcp`
and `altegio/altegio-mcp-platform` (via `gh`), the shared skills and server inventory, DNS
lookups, read-only Integrations Hub calls. `gcloud` was not available, so the live GCP setup was
not inspected.

## I1. GCP project and billing

What exists:

- The platform runs in project `altegio-mcp`, region `europe-west1`: Cloud Run services
  `mcp-proxy` (`mcp.alteg.io`) and `mcp-proxy-internal` (`mcp.altegio.dev`), Artifact Registry
  `europe-west1-docker.pkg.dev/altegio-mcp/cloud-run`, 1 vCPU, 256Mi, min 0, max 10 instances,
  deployed by Cloud Build triggers. That project belongs to the platform team.
- Altegio.Pro MCP itself is not on Cloud Run: its container runs on GCE VMs and deploys by a cron
  `git pull`.
- Every other Altegio GCP service has its own project in `europe-west1` (for example
  `ops-kommo-tusker`, `ops-client-researcher`, `intercom-tickets-qa`). There is no shared
  "AI services" project.
- Company policy (altegio-vibe-coder, gcp-cicd, server inventory): GCP first, deploy only through
  a Cloud Build trigger on merge to `main`, secrets in Secret Manager, required `test` check and
  ruleset, cost estimate in the README, a row in the GCP table of the server inventory. Org
  policy may block `allUsers`; other public services use `--ingress=all` with
  `run.googleapis.com/invoker-iam-disabled=true`.

Proposal: a new project `altegio-me-mcp` in `europe-west1` with Artifact Registry repo
`cloud-run`, Cloud Run service `altegio-me-mcp`, runtime service account
`altegio-me-mcp-runtime@`, trigger `altegio-me-mcp-deploy` running `/cloudbuild.yaml`.

- We do: `cloudbuild.yaml`, Dockerfile, README cost estimate, the inventory PR, then IAM and
  secrets once we have project rights.
- Needs org or infra rights: create the project and link billing, connect the GitHub org to
  Cloud Build (2nd gen, GitHub org admin), enable the APIs. Ask in Slack `#dev-ai-coding`.

Cost estimate (list prices, to verify): 1 vCPU / 512Mi, min 0 instances, request-billed: about
$0-2 per month at low volume. Min 1 instance (no cold starts during directory review): about
$10 per month. Secret Manager, Artifact Registry, Cloud Build, domain mapping: under $1 per month.

## I2. Domain and DNS

> Superseded 2026-10-04 by [ADR 0002](../decisions/0002-public-address-on-platform-proxy.md):
> the public address is `https://mcp.alteg.io/me` on the platform proxy. This section stays as
> the fallback if the platform team cannot add an anonymous route.

What exists:

- `mcp.alteg.io` and `mcp.altegio.dev` are Cloud Run domain mappings: CNAME to
  `ghs.googlehosted.com`, DNS-only (not proxied) in Cloudflare, so Google can issue the
  certificate and Cloudflare stays out of the streaming connection. No load balancer.
- DNS for `alteg.io`, `altegio.me` and `altegio.dev` is in Cloudflare under the organization
  account; Cloudflare is the source of truth. The `altegio.me` zone hosts the WordPress partner
  landing.
- `altegio.me` resolves (Cloudflare name servers, registrar GoDaddy). **Registration expires
  2026-11-22**: confirm auto-renew. A proxied wildcard `*.altegio.me` exists, so `mcp.altegio.me`
  already answers with an empty page. No CAA record, so Google-managed certificates are allowed.

Proposal: `mcp.altegio.me`, the same pattern as `mcp.alteg.io`.

1. The Google account that creates the mapping becomes a verified owner of `altegio.me` in Search
   Console (an existing owner adds it).
2. `gcloud beta run domain-mappings create --domain=mcp.altegio.me --service=altegio-me-mcp --region=europe-west1`.
3. In the Cloudflare zone `altegio.me`, add CNAME `mcp` to `ghs.googlehosted.com`, not proxied
   (an explicit record overrides the wildcard).
4. Wait 15-60 minutes for the certificate.

We do step 2. Steps 1 and 3 need the Search Console owner and Cloudflare write access to the
`altegio.me` zone; ask in `#dev-ai-coding` or `#altegio-mcp-platform`.

## I3. Partner token

Decision (owner, 2026-10-03): use the partner token of the existing developer account 2630
"Altegio AI" (it holds Altegio.Pro MCP, Knowledge MCP and Integrations Hub MCP). No new developer
account, app or marketplace listing. Accepted trade-offs: per-partner rate limits and anti-fraud
state are shared with Altegio.Pro MCP, and the token cannot be revoked independently. Locally the
token lives in `.env` (never committed), in production in Secret Manager (Phase 3). The proposal
below is superseded; it stays for the record.

What exists:

- Altegio.Pro MCP reads `ALTEGIO_API_TOKEN` (developer account settings → account details). In
  production it is the Secret Manager secret `ALTEGIO_API_TOKEN` in `altegio-mcp`, written into
  the VM's container env and mounted into `mcp-proxy`.
- The platform docs describe it as the single partner credential, shared by both stacks; which
  developer account issued it is not documented.
- Altegio-owned developer accounts include 2630 "Altegio AI", which holds the Pro MCP,
  Knowledge MCP and Integrations Hub MCP applications.

Proposal: a dedicated developer account for Altegio.me MCP, created at
`app.alteg.io/appstore/developers/1`. Its partner token goes into Secret Manager in our project,
readable only by the runtime service account. No application or marketplace listing is needed:
the `book_*` routes check no per-business install. Do not reuse the Pro MCP token: per-partner
rate limits and anti-fraud state would be shared, it could not be revoked independently, and a
future dedicated partner type (B3) needs a partner id of its own.

- We do: create the developer account (Integrations Hub `create_developer_account`, plan mode
  first) and store the token.
- Needs the backend team later, if we hit limits (B3): per-partner limits, rate-limit exemption,
  partner type for the new partner id.
