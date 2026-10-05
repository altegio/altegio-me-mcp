# Runbook: altegio-me-mcp on Cloud Run in the platform project

Operations for the hosted service (ADR-0003, Phase 3). The service runs as its own Cloud Run
service in the platform's project `altegio-mcp`, region `europe-west1`. The one-time setup is
`scripts/gcp/bootstrap.sh`; the deploy pipeline is `cloudbuild.yaml`. This document holds names,
procedures and limits. It contains no secret value and no e-mail address: the owner's address is
a parameter of the script.

## Resources

Every name below is created by `scripts/gcp/bootstrap.sh` unless the owner column says the
platform owns it. The label `app=altegio-me-mcp` goes where the resource type supports one.

| Resource | Name | Where | Owner | Carries `app=altegio-me-mcp` |
| --- | --- | --- | --- | --- |
| Cloud Run service | `altegio-me-mcp` | `altegio-mcp`, `europe-west1` | this project | yes (`--labels`) |
| Runtime service account | `altegio-me-mcp-runtime` | `altegio-mcp` | this project | in the description (accounts have no labels) |
| Build service account | `altegio-me-mcp-build` | `altegio-mcp` | this project | in the description |
| Cloud Build trigger | `altegio-me-mcp-deploy` | `altegio-mcp`, `europe-west1` | this project | no: triggers have tags, not labels, and the script sets none |
| Repository link | `altegio-altegio-me-mcp` on connection `Altegio` (the owner-repo id the platform asked for) | `europe-west1` | this project (the connection is the platform's) | no |
| Artifact Registry repository | `cloud-run` | `europe-west1` | the platform | no |
| Secret, partner token | `MARKETPLACE_PARTNER_TOKEN` (the name is the `--token-secret` parameter; it holds the account-2630 token, verified by hash 2026-10-05) | Secret Manager | the platform | no |
| Secret, proxy key | `MCP_PROXY_BACKEND_KEY_ME` (the name is the `--proxy-key-secret` parameter; the key issued for the `/me` route, read by this service and by the customer proxy) | Secret Manager | this project (created 2026-10-05) | yes (`--labels`) |
| E-mail channel | `altegio-me-mcp-owner` | Cloud Monitoring | this project | yes (`--user-labels`) |
| Uptime check, service | `altegio-me-mcp-health` | Cloud Monitoring | this project | yes |
| Uptime check, public route | `altegio-me-mcp-public` (only with `--public-check`) | Cloud Monitoring | this project | yes |
| Alert policy, down | `altegio-me-mcp-down` | Cloud Monitoring | this project | yes (`userLabels`) |
| Log-based metrics | `altegio_me_mcp_upstream_unauthorized`, `altegio_me_mcp_upstream_rate_limited`, `altegio_me_mcp_upstream_unavailable` | Cloud Logging | this project | no: the metric has a description that names the app |
| Alert policies, upstream | `altegio-me-mcp-upstream-unauthorized`, `altegio-me-mcp-upstream-rate-limited`, `altegio-me-mcp-upstream-unavailable` | Cloud Monitoring | this project | yes |
| Drill objects (temporary) | `altegio-me-mcp-alert-drill` (check and policy) | Cloud Monitoring | this project | yes; deleted after each drill |

Cost attribution by label therefore works for Cloud Run only. Everything else is found by name.
The platform lists the monitoring objects in its own `ops/MONITORING.md`; a PR for that file is
prepared with the owner and approved by her.

## Access needed (I6)

Someone with these rights runs the setup once. The recommended way is a platform engineer
running `--apply` with the owner watching; the owner can also run it herself if the platform
grants the rights.

| Need | Roles that cover it |
| --- | --- |
| Create the two service accounts | `roles/iam.serviceAccountAdmin` |
| Create the Cloud Run service, set its IAM and turn the invoker check off | `roles/run.admin` |
| Link the repository and create the trigger on connection `Altegio` | `roles/cloudbuild.builds.editor`, plus the Cloud Build GitHub App allowed to see the repository |
| Create checks, policies and the channel | `roles/monitoring.editor` |
| Create the three log-based metrics | `roles/logging.configWriter` |
| Bind the runtime account on the two secrets | `secretmanager.secrets.setIamPolicy` on those two secrets (for example `roles/secretmanager.admin` scoped to them) |
| Bind the build account on the repository `cloud-run` | `artifactregistry.repositories.setIamPolicy` on that repository |
| The one project-level binding (`roles/logging.logWriter` for the build account) | a project IAM administrator |
| Read-only checks of the step 0 preflight and the step 7 report | project viewer, secret metadata viewer, and read of the `_Default` log bucket |

The script never enables an API, never changes the log bucket, and never reads a secret payload.
Also ask the platform: whether the `cloud-run` repository may be shared (see
`## Known limits`), which secret holds the account-2630 token (answered 2026-10-05:
`MARKETPLACE_PARTNER_TOKEN`, verified by hash; `ALTEGIO_API_TOKEN` is Altegio.Pro MCP's token), and
what the real `_Default` log retention is (30 days, read 2026-10-05).

## Bootstrap

`scripts/gcp/bootstrap.sh` is idempotent: every step checks before it creates, so a second run
creates nothing. It is bash 3.2 compatible, so the macOS `/bin/bash` runs it. It needs the Cloud SDK
`beta` component (`gcloud components install beta`): `gcloud monitoring channels` is not a GA command
group, and the preflight blocks when the component is missing.

1. `--print` is the review artifact. It prints every write the script would make, in order, and
   never calls gcloud. Give this output to the platform engineer.

   ```bash
   bash scripts/gcp/bootstrap.sh --print --owner-email ADDRESS
   ```

2. `--plan` (the default) is read-only. It checks the project, the APIs, the repository, the
   connection and the two secrets, then lists what is missing and what it would run. It exits 1
   with a `BLOCKER` line when a prerequisite is missing, or when an existing trigger or service
   runs as an account other than ours (the default compute account has secret access in this
   project; our trigger and service must never use it).

   ```bash
   bash scripts/gcp/bootstrap.sh --plan
   ```

3. `--apply` creates only what is missing.

   ```bash
   bash scripts/gcp/bootstrap.sh --apply --owner-email ADDRESS
   ```

Parameters: `--token-secret NAME` (default `MARKETPLACE_PARTNER_TOKEN`, the secret that holds the
account 2630 token, set on both the runtime binding and the trigger substitution
`_TOKEN_SECRET`), `--proxy-key-secret NAME` (default `MCP_PROXY_BACKEND_KEY_ME`), `--project`,
`--region`, `--skip-secret-bindings` (a platform engineer binds the two secrets separately; the
script then prints and runs no secret binding), `--public-check` (after the platform route is
live), `--drill`, `--drill-cleanup`. The owner's address is a parameter only. It is not written to
any file, and the script file contains no address.

What the steps do, in order: (0) read-only preflight; (1) the two service accounts; (2) the
runtime account reads the two secrets, at secret level only; (3) the build account gets
`roles/logging.logWriter` on the project (with `--condition=None`), `roles/artifactregistry.writer`
on the repository, and `roles/iam.serviceAccountUser` on the runtime account; (4) the Cloud Run
service, then `roles/run.developer` for the build account on that service only; (5) the repository
link and the trigger; (6) the owner's e-mail channel, the checks, the three log-based metrics and
the policies; (7) a read-only report with the service URL, the trigger's account, the `_Default`
retention in days and whether the owner's channel is verified.

The build account has no secret access and no right to create or change other services. It starts
without `roles/cloudbuild.builds.builder`. Add that role only if the build log does not appear in
the Cloud Build console. Add `roles/secretmanager.viewer` on the two secrets for the build account
only if the first deploy fails while validating `--set-secrets`; never `secretAccessor`.

**The single exception to the git-only deploy rule.** Production changes reach Cloud Run only
through the Cloud Build trigger on a merge to `main`. Step (4) runs `gcloud run deploy` once, and
only while the service is missing, from Google's placeholder image
`us-docker.pkg.dev/cloudrun/container/hello`. It never deploys our image. It exists because the
build account (`roles/run.developer`) cannot turn the invoker IAM check off, and the trigger's
`--no-traffic` deploy needs an existing service to update (research Pitfalls 8 and 9). The
placeholder page is public until the first merge deploys our code. Every revision of our code
comes only from the trigger. When the service exists, step (4) changes at most one setting: it
turns the invoker check off if it is on.

Before the first `--apply`, check that the Cloud Build GitHub App installation on the `altegio`
organisation can see the repository `altegio/altegio-me-mcp`. If the App was installed for selected
repositories only, an organisation admin adds the repository first; otherwise the repository link
fails.

If a binding fails right after an account was created, wait a minute and run the script again:
IAM changes propagate with a delay, and a rerun skips what already exists.

## Trigger from the Console

If `gcloud builds triggers create github` returns `INVALID_ARGUMENT` (it often does for
repositories on a second-generation connection), create the trigger in the Console and run
`--plan` afterwards to confirm it:

1. Cloud Build, Triggers, region `europe-west1`, Create trigger.
2. Name `altegio-me-mcp-deploy`. Event: push to a branch.
3. Source: 2nd gen, connection `Altegio`, repository `altegio-altegio-me-mcp`. Branch `^main$`.
4. Configuration: Cloud Build configuration file, location `/cloudbuild.yaml`.
5. Ignored files filter: `docs/**`, `**/*.md`, `.github/**`, `scripts/**`. A merge that changes
   only those paths starts no build; every other change does.
6. Substitution variables: `_TOKEN_SECRET` and `_PROXY_KEY_SECRET` with the secret names in use.
7. Service account: choose the build account `altegio-me-mcp-build` of project `altegio-mcp`
   **explicitly**. Leaving the field empty runs the build as a default account.
8. Verify, read-only:

   ```bash
   gcloud builds triggers describe altegio-me-mcp-deploy --region=europe-west1 --project=altegio-mcp --format='value(serviceAccount)'
   ```

   The value must be `projects/altegio-mcp/serviceAccounts/` followed by the build account's
   address (`altegio-me-mcp-build`, then `@`, then `altegio-mcp.iam.gserviceaccount.com`).

## Deploy flow

The trigger remains main-push under `altegio-me-mcp-build`; its production path
is `cloudbuild.yaml`. Read [the operational contract](operations.md) before a
release, rollback, scaling change or public-route publication.

1. Increment `release.json.sequence` for operational/runtime changes; CI verifies
   forward order. Release-script changes need this root file because the trigger
   ignores `scripts/**`.
2. Build and require the signed HTTPS image gate, then push the commit-tag image.
3. Acquire a Cloud Run service annotation lock with v2 etag; serialize candidate
   deployment, smoke test, explicit revision promotion and candidate-only cleanup.
4. Verify tagged liveness/commit and direct unsigned 401 before promotion. Verify
   production liveness after promotion; automatically restore previous traffic
   if it fails. Real signed protocol and read-only canary are separate signals.

Older completed release numbers cannot shift traffic. Failed candidates retain
no revision minimum and only their own tag is removed. A terminated build or
unknown operation retains the lock until its terminal status is verified; see
operations.md for recovery. Never use `--clear-tags` on a shared release surface.

## Rollback

A rollback is a revert PR: revert the bad commit on a branch, open a PR, wait for the required
`test` check, merge. The merge goes through the same trigger, the same smoke test and the same
guarded shift, so the previous behaviour returns by the normal path.

Emergency only, and only with the owner's approval: move traffic to a known good revision by hand.

```bash
gcloud run revisions list --service=altegio-me-mcp --region=europe-west1 --project=altegio-mcp
gcloud run services update-traffic altegio-me-mcp --to-revisions=<previous>=100 --region=europe-west1 --project=altegio-mcp
```

Follow it at once with the revert PR: the next merge deploys a new revision and shifts traffic to
it, which would bring the bad code back if the revert is not in. Record the move in
`## Deployment record`.

## Secret rotation

Both secrets are mounted as files and the service re-reads them; nothing is restarted.

- **Partner token** (`MARKETPLACE_PARTNER_TOKEN` or the secret named by `--token-secret`): the file is
  re-read lazily within 60 seconds of a request. A 401 or 403 from Altegio forces one re-read (at
  most once per 60 seconds) and one retry with the new value. To rotate, add a new secret version.
  The customer proxy uses the same token for marketplace confirmations, so the platform coordinates
  its rotation. Altegio.Pro MCP runs under a different token (`ALTEGIO_API_TOKEN`).
- **Proxy key** (`MCP_PROXY_BACKEND_KEY_ME`, issued for this route, or the secret named by
  `--proxy-key-secret`): the file
  holds a comma-separated list during a rotation. Follow the platform's sequence: `old,new` (both
  accepted), then the platform's proxy switches to signing with the new key (`new,old`), then
  `new` alone once nothing signs with the old one. Each key is at least 32 characters.
- The alert `altegio-me-mcp-upstream-unauthorized` (3 refusals in 5 minutes) means Altegio refuses
  the token on real calls while `/health` and `tools/list` stay green. Check whether the token was
  revoked or rotated without a new secret version reaching the service; read the call log for
  `upstream_kind="unauthorized"` first.

## Monitoring

Two uptime checks run every 5 minutes from three regions (`europe`, `usa-iowa`, `asia-pacific`)
and call no Altegio API:

- `altegio-me-mcp-health`: `GET /health` on the `run.app` host, content `"status":"ok"`. It tests
  our service alone, so it separates a failing service from a failing proxy.
- `altegio-me-mcp-public` (created with `--public-check` after the platform route is live): `POST
  tools/list` to `https://mcp.alteg.io/me` with `Accept: application/json, text/event-stream`,
  content `business_get`. It tests the proxy, the route, the signature and the service together.

Policy `altegio-me-mcp-down` counts failing locations per host and fires when more than one
location fails for 10 minutes, so a blip from one region does not page. Three more policies feed
on log-based metrics built from the `mcp_call` lines (`upstream_kind` is a closed enum): at least 3
`unauthorized` in 5 minutes, at least 10 `rate_limited` in 10 minutes, at least 10 `unavailable` in
10 minutes. They exist because `/health` and `tools/list` stay green while a revoked token fails
every real call.

All four policies notify only the owner's e-mail channel `altegio-me-mcp-owner`. The script
attaches no other channel, and the platform's autoheal channel must never be attached: a fault in
our service must not reset the platform's VMs.

**Changed by the platform owner on 2026-10-05 ("identical to Pro"):** every policy now also
notifies the platform's `mcp-proxy oncall` e-mail channel, and `altegio-me-mcp-upstream-rate-limited`
is disabled (its metric stays). The script creates policies with the owner's channel only and does not
reconcile channels afterwards; **do not run `--public-check` until the down-policy update preserves
the policy's existing channels**, or the on-call channel would be dropped from `altegio-me-mcp-down`.
The public path is probed by the platform's `mcp-public-surface` check (altegio-monitoring, every
15 minutes, anonymous `tools/list` on `https://mcp.alteg.io/me`) and by `mcp-customer-runtime`
(our `/health` and a signed `business_get(722227)` canary), so a public uptime check of our own is a
decision for the owner, not a gap.

Cost: about $3 a month for two checks at 5 minutes (about 51,840 executions a month at roughly
$0.30 per 1,000, with the project's free tier already used by the platform's own checks). One
minute would cost about 12 times as much (about $140 a month), which is why the period is 5.
Detection takes 5 to 10 minutes.

An unverified e-mail channel may need the owner to confirm a mail. The step 7 report shows its
verification status; the drill proves delivery.

## Alert drill

Proves that a failing check reaches the owner's inbox without taking the service down.

```bash
bash scripts/gcp/bootstrap.sh --drill
```

`--drill` implies `--apply`. It creates `altegio-me-mcp-alert-drill`, a `/health` check with a
content matcher that can never match (period 1 minute), and a drill policy of the same shape on the
same e-mail channel. It then waits up to 15 minutes, polling every 60 seconds and printing what the
check reports and a link to the Console incident list (gcloud has no command that lists
incidents). Press Enter in an interactive terminal to end it early once the mail has arrived. It
deletes both objects at the end, also when interrupted. The real check and the real policy are not
touched, so a real outage during a drill still pages through the real policy.

1. Run the drill and watch the owner's inbox for the incident mail.
2. Confirm that the incident opened, and that it closed after the delete.
3. If no mail arrives, confirm the channel's verification status (step 7 of the bootstrap) and
   confirm the mail address with the owner.
4. If a drill was cut off hard and left objects behind, `bash scripts/gcp/bootstrap.sh
   --drill-cleanup` removes them.

Record the date and the result in `## Deployment record`.

## Public route checks

Run these once the platform's `/me` route exists, in this order.

Results on 2026-10-05, after altegio-mcp-platform #250 deployed the customer proxy (build 794c5e05,
15:35 UTC): (1) the live metric selects `resource.labels.service_name="mcp-proxy-internal"` only, so
`/me` and `/me/mcp` are outside it without an exclusion; (2) `smoke-url.sh --public` PASS, and both
discovery forms answer 404; (3) the unsigned direct call answers 401 (`scripts/verify-backend.py`,
which also proves the signed protocol, the `business_get(722227)` canary and request correlation);
(4) the public uptime check is not created yet, see `## Monitoring`.

1. Before the first public request, confirm that the platform's log-based metric
   `mcp_proxy_upstream_502` excludes both `/me` and `/me/mcp`. A fault in our service must not feed
   the platform's autoheal. This reads the metric's definition and changes nothing:

   ```bash
   gcloud logging metrics describe mcp_proxy_upstream_502 --project=altegio-mcp --format='value(filter)'
   ```

   The filter must exclude the short address `https://mcp.alteg.io/me` and the long form
   `https://mcp.alteg.io/me/mcp`. The documented filter requires the URL to end in `/mcp`, so the
   short form is not matched by it unless it is excluded or the pattern is widened. If either
   address is not excluded, stop and ask the platform to add the exclusion.

2. The public path: `bash scripts/smoke-url.sh --public https://mcp.alteg.io/me` (initialize and
   `tools/list` answer 200, no `mcp-session-id`, no redirect, and the protected-resource metadata
   route is 404).
3. The direct `run.app` address must refuse an unsigned call with 401:
   `bash scripts/smoke-url.sh <run.app URL> <commit>` checks `/health` and that refusal.
4. Create the public check and add it to the down policy by running the bootstrap again with
   `--public-check`.

## Live load run

The live scenario spends developer 2630 quota shared with platform marketplace confirmations; Pro uses a different token.

- Coordinate the run with marketplace confirmation maintainers first, with the time window.
- `npm run loadtest -- --scenario=live --confirm-announced` refuses to start without
  `--confirm-announced`. It uses the read-only tools without `book_check`, on location 726120, runs
  at most 180 seconds, and is capped at 1.35 upstream calls per second (90 percent of the gate).
- Hard stop: the run ends at the first busy or not-accepted tool error and at the first HTTP 401,
  429 or 5xx. Do not rerun after a stop without finding the cause and telling the maintainers.
- The results file goes under the ignored `loadtest-output/` directory; summarize it in the
  deployment record.

## Known limits

- **`run.app` cannot be closed to the proxy.** Internal ingress admits only callers inside the
  same project's VPC, and the platform's proxy reaches a `run.app` address through public egress; an
  IAM invoker rule would need the proxy to send an ID token, which its https lane does not do. The
  service therefore runs with `--ingress=all` and the invoker check off, and relies on the proxy
  signature check on `/mcp` (`/health` stays open). Tagged revision URLs are public for the same
  reason.
- **`roles/artifactregistry.writer` is repository-wide** in the shared repository `cloud-run`: the
  build account could overwrite another image's tag there. The residual risk is controlled by the
  trigger running only on `main`, behind the required `test` check, and by pushing only the
  commit-SHA tag. If the platform objects, the fallback is a repository of our own.
- **No static egress IP.** Cloud Run egress uses dynamic Google addresses, so Altegio's per-IP
  limits cannot be relied on to be per service; the gate's budget is shared and conservative.
- **Scaling and rollout overlap.** Service and revision max are 1, service min is 1,
  revision min is 0. Production gates allocate 90 starts/minute and 2/second per
  process, reserving two processes during serialized rollout. Cloud Run maxima
  can be temporarily exceeded; they are not a hard distributed quota. See
  operations.md for marketplace reserve, monitoring and scaling restrictions.
- **The shared proxy key** widens who holds it. The service has no VPC egress, so it cannot reach
  the platform's VM backends, which bounds the impact; a key issued for this route is preferred.

## Deployment record

Filled in at each live step (first bootstrap, first deploy, drill, public route, live load run,
rollbacks and manual changes).

| Date | Step | Revision | Commit | Who ran it | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-10-05 | Pre-work by the platform owner: build account `altegio-me-mcp-build` with `roles/logging.logWriter` (project) and `roles/artifactregistry.writer` (`cloud-run`) | none | none | the platform owner | found by the script and skipped |
| 2026-10-05 | Repository link `altegio-altegio-me-mcp` on connection `Altegio` (the platform owner's command, by hand); secret `MCP_PROXY_BACKEND_KEY_ME` created (64 hex characters) with `secretAccessor` for `mcp-proxy-customer-sa` | none | 6f2996e | the owner, with `roles/owner` granted by the platform owner the same day | both present; the GitHub App already saw the repository |
| 2026-10-05 | Bootstrap `--apply`, three runs | `altegio-me-mcp-00001-lvh` (placeholder image) | e32e83b | the owner | run 1 stopped at the first metric policy (`COMPARISON_GE` rejected, fixed in c5e9b92); run 2 stopped there again (a new log-based metric is not visible to Monitoring for a few minutes, retry added in e32e83b); run 3 finished. `--plan` after: 0 writes, 0 blockers. `_Default` retention 30 days. Owner channel created; its verification status was not reported |
| 2026-10-05 | First trigger build `9ff5912c` on the merge of PR #4 | none | c5477f8 | the trigger, as `altegio-me-mcp-build` | FAILURE at step `build`: `$PROJECT_ID` inside the `_IMAGE` substitution value was not expanded, so the image tag was invalid; fixed by writing the project into `_IMAGE`; traffic stayed on the placeholder |
| 2026-10-05 | First git-only deploy: trigger build `0c0fae37` on the merge of PR #5 | `altegio-me-mcp-00002-kih` (version 0.2.0) | c73ecb7 | the trigger, as `altegio-me-mcp-build` | SUCCESS, all seven steps in 2 min 49 s: smoke PASS on the tag URL, traffic shifted to 100%, tag removed; `/health` reports the merge commit and 0.2.0; `smoke-url.sh` PASS on `run.app`; the placeholder revision `00001-lvh` stays at 0% |
| 2026-10-05 | Alert policies changed by the platform owner (14:42 UTC, `y@alteg.io`) | none | none | the platform owner | the `mcp-proxy oncall` e-mail channel added to all four policies; `altegio-me-mcp-upstream-rate-limited` disabled, metric kept; "identical to Pro" |
| 2026-10-05 | Release pipeline reworked by the platform owner (PR #7, merge 56ca858): `release.json` sequence, `scripts/release.py`, signed HTTPS image gate | none | 56ca858 | the trigger, as `altegio-me-mcp-build` | build `5c3f284f` FAILED after the image gate and push: polling a regional Cloud Run operation answered 403 under the service-scoped build account; no revision or traffic change, `00002-kih` kept serving; the orphan release lock was cleared by the platform owner |
| 2026-10-05 | Second release through the new pipeline (PR #8, merge 4c781e6): service-GET reconciliation instead of operation polling, signed `x-mcp-auth-request-id` correlation | `altegio-me-mcp-b32ak5r5qmvb57g246qju3odyua` (version 0.2.0, release sequence 2) | 4c781e6 | the trigger, as `altegio-me-mcp-build` | build `de80aec7` SUCCESS at 15:01 UTC; 100% explicit traffic, no candidate tag or lock left; `verify-backend.py` PASS (liveness and commit, signed initialize and six-tool list, `business_get(722227)`, correlation, unsigned 401) |
| 2026-10-05 | Public route live: altegio-mcp-platform #250 (built on our #248) merged 15:32 UTC, customer proxy build `794c5e05` at 15:35 UTC | unchanged | ce32a45 (platform) | the platform owner | `https://mcp.alteg.io/me`: anonymous `tools/list` 200 with six tools, discovery 404 in both forms, `GET /` lists `/me` with `auth: none`; `smoke-url.sh --public` PASS; monitoring #39 deployed before publication (`me_monitoring_ready=true`) |
| 2026-10-05 | Alert drill (`bootstrap.sh --drill`, plan 03-15 H6/H8) | none | 7e03c8c | the owner | the throwaway check `altegio-me-mcp-alert-drill` (period 1 minute, impossible matcher) failed from all three regions within minutes; the drill policy opened an incident and the owner's e-mail channel delivered the ALERT mail at 05:16 UTC and the RESOLVED mail at 05:27 UTC, after the script deleted both objects at 05:26 UTC; nothing left behind (`list-configs` and `policies list` empty for the drill name); the real check and policy were not touched |
