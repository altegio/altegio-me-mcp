#!/usr/bin/env bash
# One-time setup of altegio-me-mcp in the platform's GCP project (OPS-01, OPS-02,
# OPS-04, OPS-05; ADR-0003, D-05). Idempotent and reviewable: every step checks
# before it creates, and nothing is created that is not named altegio-me-mcp.
#
#   scripts/gcp/bootstrap.sh --print --owner-email ADDRESS
#       Prints every write the script would make, in order, and calls gcloud
#       never. This is the review artifact for the platform engineer.
#   scripts/gcp/bootstrap.sh --plan [--owner-email ADDRESS]      (the default)
#       Read-only. Checks the project and lists what is missing.
#   scripts/gcp/bootstrap.sh --apply --owner-email ADDRESS
#       Creates only what is missing.
#
# Other flags:
#   --token-secret NAME        secret holding the partner token (ALTEGIO_API_TOKEN)
#   --proxy-key-secret NAME    secret holding the proxy key (MCP_PROXY_BACKEND_KEY)
#   --project ID               GCP project (altegio-mcp)
#   --region NAME              region (europe-west1)
#   --skip-secret-bindings     a platform engineer binds the two secrets apart
#   --public-check             also create the public-route uptime check (needs
#                              the platform route to exist)
#   --drill                    alert drill: throwaway check and policy, wait up
#                              to 15 minutes, delete both (implies --apply)
#   --drill-cleanup            delete drill leftovers (implies --apply)
#
# Needs the Cloud SDK beta component (gcloud components install beta): the
# notification channel commands are not a GA command group, and the preflight
# blocks when the component is missing.
#
# What it never does: enable an API, change a log bucket or any project-wide
# setting, bind anything to another service or another secret, grant a public
# invoker, read a secret payload, use the project's default compute service
# account, or attach any notification channel but the owner's e-mail one. The
# guard in gwrite refuses such a command even if a later edit adds one.
#
# The owner's address is a parameter; it is never written to a file here.
# Bash 3.2 syntax only (macOS /bin/bash): no associative arrays, no mapfile, no
# case-changing expansions, no empty-array expansions under set -u.
set -euo pipefail

# ---- fixed names (ADR-0003, D-05) -------------------------------------------
PROJECT=altegio-mcp
REGION=europe-west1
SERVICE=altegio-me-mcp
AR_REPO=cloud-run
CONNECTION=Altegio
REPO_LINK=altegio-altegio-me-mcp # the link id the platform asked for (owner-repo form)
REMOTE_URI=https://github.com/altegio/altegio-me-mcp.git
TRIGGER=altegio-me-mcp-deploy
RUNTIME_SA_NAME=altegio-me-mcp-runtime
BUILD_SA_NAME=altegio-me-mcp-build
CHANNEL_NAME=altegio-me-mcp-owner
HEALTH_CHECK=altegio-me-mcp-health
PUBLIC_CHECK=altegio-me-mcp-public
DRILL_CHECK=altegio-me-mcp-alert-drill
DOWN_POLICY=altegio-me-mcp-down
DRILL_POLICY=altegio-me-mcp-alert-drill
PLACEHOLDER_IMAGE=us-docker.pkg.dev/cloudrun/container/hello
APP_LABEL=app=altegio-me-mcp
CHECK_REGIONS=europe,usa-iowa,asia-pacific
TOKEN_SECRET=ALTEGIO_API_TOKEN
PROXY_KEY_SECRET=MCP_PROXY_BACKEND_KEY

# Drill pacing, overridable so the stubbed test does not wait a quarter hour.
DRILL_POLL_SECONDS="${BOOTSTRAP_DRILL_POLL_SECONDS:-60}"
DRILL_MAX_POLLS="${BOOTSTRAP_DRILL_MAX_POLLS:-15}"

# ---- arguments --------------------------------------------------------------
MODE=''
ACTION=bootstrap
OWNER_EMAIL=''
SKIP_SECRET_BINDINGS=0
PUBLIC_CHECK_ON=0

usage() {
  echo "usage: scripts/gcp/bootstrap.sh [--print | --plan | --apply] --owner-email ADDRESS" >&2
  echo "         [--token-secret NAME] [--proxy-key-secret NAME] [--project ID] [--region NAME]" >&2
  echo "         [--skip-secret-bindings] [--public-check]" >&2
  echo "       scripts/gcp/bootstrap.sh --drill | --drill-cleanup [--print | --plan]" >&2
  echo "       --owner-email is required with --print and --apply." >&2
  exit 2
}

need_value() {
  if [ "$1" -lt 2 ]; then usage; fi
}

set_mode() {
  if [ -n "$MODE" ] && [ "$MODE" != "$1" ]; then usage; fi
  MODE=$1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --print) set_mode print; shift ;;
    --plan) set_mode plan; shift ;;
    --apply) set_mode apply; shift ;;
    --owner-email) need_value $#; OWNER_EMAIL=$2; shift 2 ;;
    --token-secret) need_value $#; TOKEN_SECRET=$2; shift 2 ;;
    --proxy-key-secret) need_value $#; PROXY_KEY_SECRET=$2; shift 2 ;;
    --project) need_value $#; PROJECT=$2; shift 2 ;;
    --region) need_value $#; REGION=$2; shift 2 ;;
    --skip-secret-bindings) SKIP_SECRET_BINDINGS=1; shift ;;
    --public-check) PUBLIC_CHECK_ON=1; shift ;;
    --drill)
      if [ "$ACTION" != bootstrap ] && [ "$ACTION" != drill ]; then usage; fi
      ACTION=drill; shift ;;
    --drill-cleanup)
      if [ "$ACTION" != bootstrap ] && [ "$ACTION" != cleanup ]; then usage; fi
      ACTION=cleanup; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

if [ -z "$MODE" ]; then
  if [ "$ACTION" = bootstrap ]; then MODE=plan; else MODE=apply; fi
fi

if [ "$ACTION" = bootstrap ] && { [ "$MODE" = print ] || [ "$MODE" = apply ]; }; then
  if [ -z "$OWNER_EMAIL" ]; then usage; fi
fi
if [ -n "$OWNER_EMAIL" ]; then
  case "$OWNER_EMAIL" in
    *@*.*) ;;
    *) echo "--owner-email must look like an e-mail address" >&2; exit 2 ;;
  esac
fi
case "$TOKEN_SECRET" in
  '' | *[!A-Za-z0-9_-]*) echo "--token-secret must be a secret name" >&2; exit 2 ;;
esac
case "$PROXY_KEY_SECRET" in
  '' | *[!A-Za-z0-9_-]*) echo "--proxy-key-secret must be a secret name" >&2; exit 2 ;;
esac
case "$PROJECT" in
  '' | *[!a-z0-9-]*) echo "--project must be a project id" >&2; exit 2 ;;
esac
case "$REGION" in
  '' | *[!a-z0-9-]*) echo "--region must be a region name" >&2; exit 2 ;;
esac

RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
BUILD_SA_EMAIL="${BUILD_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
# The trigger runs as this account. It is computed here and compared with an
# independently spelled expectation in assert_trigger_account.
TRIGGER_SA="projects/${PROJECT}/serviceAccounts/${BUILD_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
REPO_PATH="projects/${PROJECT}/locations/${REGION}/connections/${CONNECTION}/repositories/${REPO_LINK}"
OWNER_EMAIL_SHOWN="${OWNER_EMAIL:-OWNER_EMAIL}"

# ---- plumbing ---------------------------------------------------------------
BLOCKERS=0
PENDING=0
CHANNEL_REF=''
WORK_DIR=''
DRILL_ACTIVE=0

if [ "$MODE" = print ]; then
  POLICY_DIR='<policy-dir>'
else
  WORK_DIR="$(mktemp -d)"
  POLICY_DIR="$WORK_DIR"
fi

say() {
  printf '%s\n' "$*"
}

head_line() {
  say "# $*"
}

quote_arg() {
  local arg=$1 head='' val
  case $arg in
    --*=*) head="${arg%%=*}="; val=${arg#*=} ;;
    *) val=$arg ;;
  esac
  case $val in
    '') printf "%s''" "$head" ;;
    *[!A-Za-z0-9_./:@,=+%-]*) printf "%s'%s'" "$head" "$(printf '%s' "$val" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s%s' "$head" "$val" ;;
  esac
}

join_cmd() {
  local out='' a
  for a in "$@"; do
    out="$out $(quote_arg "$a")"
  done
  printf '%s' "${out# }"
}

block() {
  BLOCKERS=$((BLOCKERS + 1))
  say "BLOCKER: $*"
}

# A read never runs in --print mode: that mode must not call gcloud at all.
gread() {
  if [ "$MODE" = print ]; then
    echo "internal error: gcloud read in --print mode" >&2
    exit 70
  fi
  gcloud "$@"
}

# value LABEL-free capture: the command's stdout, or nothing.
value() {
  local out=''
  if [ "$MODE" = print ]; then return 0; fi
  out=$(gread "$@" 2>/dev/null) || out=''
  printf '%s' "$out"
}

# has_value LABEL cmd...: true when the read-only command prints something.
has_value() {
  local label=$1 out=''
  shift
  if [ "$MODE" = print ]; then return 1; fi
  out=$(gread "$@" 2>/dev/null) || out=''
  if [ -n "$out" ]; then
    say "ok: $label"
    return 0
  fi
  say "missing: $label"
  return 1
}

# Refuse a write that reaches beyond our named resources, whatever edit adds it.
guard_write() {
  local joined=" $* "
  case "$joined" in
    *' services enable '* | *' buckets update '* | *' versions access '* | *allUsers* | *allAuthenticatedUsers* | *compute@developer* | *mcp-autoheal*)
      echo "internal error: refusing a gcloud write outside the altegio-me-mcp scope: gcloud $*" >&2
      exit 70
      ;;
  esac
}

gwrite() {
  guard_write "$@"
  case "$MODE" in
    print) printf '%s\n' "gcloud $(join_cmd "$@" "--project=$PROJECT")" ;;
    plan)
      printf '  would run: gcloud %s\n' "$(join_cmd "$@" "--project=$PROJECT")"
      PENDING=$((PENDING + 1))
      ;;
    apply)
      printf '+ gcloud %s\n' "$(join_cmd "$@" "--project=$PROJECT")"
      gcloud "$@" "--project=$PROJECT"
      ;;
  esac
}

on_exit() {
  local code=$?
  set +e
  if [ "$DRILL_ACTIVE" = 1 ]; then
    DRILL_ACTIVE=0
    echo "removing the drill check and policy" >&2
    drill_delete
  fi
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

assert_trigger_account() {
  local expected="projects/${PROJECT}/serviceAccounts/${BUILD_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  if [ "$1" != "$expected" ]; then
    echo "FATAL: the trigger would run as '$1', not as the build account $BUILD_SA_NAME" >&2
    exit 1
  fi
}

# ---- JSON for the alert policies --------------------------------------------
uptime_condition() { # $1 display name, $2 check id
  cat <<EOF
    {
      "displayName": "$1: failing from more than one location",
      "conditionThreshold": {
        "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.\"check_id\"=\"$2\"",
        "aggregations": [
          {
            "alignmentPeriod": "60s",
            "perSeriesAligner": "ALIGN_NEXT_OLDER",
            "crossSeriesReducer": "REDUCE_COUNT_FALSE",
            "groupByFields": ["resource.label.\"host\""]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 1,
        "duration": "$3",
        "trigger": { "count": 1 }
      }
    }
EOF
}

# policy_json DISPLAY DOC CONDITIONS (CONDITIONS is ready JSON, comma separated)
policy_json() {
  cat <<EOF
{
  "displayName": "$1",
  "combiner": "OR",
  "conditions": [
$3
  ],
  "alertStrategy": { "autoClose": "1800s" },
  "notificationChannels": ["$CHANNEL_REF"],
  "userLabels": { "app": "altegio-me-mcp" },
  "documentation": { "content": "$2", "mimeType": "text/markdown" },
  "enabled": true
}
EOF
}

metric_condition() { # $1 metric name, $2 threshold, $3 window seconds
  cat <<EOF
    {
      "displayName": "$1 at or above $2 in $3 seconds",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/$1\" AND resource.type=\"cloud_run_revision\"",
        "aggregations": [
          {
            "alignmentPeriod": "${3}s",
            "perSeriesAligner": "ALIGN_SUM",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GE",
        "thresholdValue": $2,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
EOF
}

# create_policy DISPLAY JSON-TEXT: write the file, print or run the create.
create_policy() {
  local display=$1 json=$2 file="$POLICY_DIR/$1.json"
  if [ "$MODE" = print ]; then
    head_line "policy file $display.json"
    printf '%s\n' "$json"
  else
    printf '%s\n' "$json" >"$file"
  fi
  gwrite monitoring policies create "--policy-from-file=$file"
}

# ---- lookups ----------------------------------------------------------------
uptime_id() { # prints the check id, or nothing
  local name out=''
  name=$(value monitoring uptime list-configs "--project=$PROJECT" "--filter=displayName=\"$1\"" '--format=value(name)')
  if [ -n "$name" ]; then out=${name##*/}; fi
  printf '%s' "$out"
}

policy_name() { # prints the policy resource name, or nothing
  value monitoring policies list "--project=$PROJECT" "--filter=displayName=\"$1\"" '--format=value(name)'
}

channel_ref() {
  value beta monitoring channels list "--project=$PROJECT" "--filter=displayName=\"$CHANNEL_NAME\"" '--format=value(name)'
}

service_host() {
  local url
  url=$(value run services describe "$SERVICE" "--region=$REGION" "--project=$PROJECT" '--format=value(status.url)')
  printf '%s' "${url#https://}"
}

# ---- step 0: read-only preflight --------------------------------------------
TRIGGER_EXISTS=0
SERVICE_EXISTS=0

preflight() {
  local enabled api label secret state
  head_line "step 0: read-only preflight (project, APIs, repo, connection, secrets, existing identities)"
  if [ "$MODE" = print ]; then
    head_line "  checked by --plan and --apply, listed here for review; APIs are reported, never enabled"
    head_line "  project $PROJECT reachable"
    head_line "  APIs on: run, cloudbuild, artifactregistry, secretmanager, monitoring, logging, iam"
    head_line "  gcloud beta component installed (monitoring channels is not a GA command group)"
    head_line "  Artifact Registry repository $AR_REPO and connection $CONNECTION exist"
    head_line "  secrets $TOKEN_SECRET and $PROXY_KEY_SECRET exist (metadata only, no payload is read)"
    head_line "  an existing trigger runs as $BUILD_SA_NAME and an existing service as $RUNTIME_SA_NAME"
    assert_trigger_account "$TRIGGER_SA"
    return 0
  fi

  if ! has_value "project $PROJECT is reachable" projects describe "$PROJECT" '--format=value(projectId)'; then
    echo "FATAL: project $PROJECT is not reachable with the current gcloud account. Use --print to review the commands without access." >&2
    exit 1
  fi

  enabled=$(value services list --enabled "--project=$PROJECT" '--format=value(config.name)')
  for api in run cloudbuild artifactregistry secretmanager monitoring logging iam; do
    case "
$enabled
" in
      *"
${api}.googleapis.com
"*) say "ok: API ${api}.googleapis.com is enabled" ;;
      *) block "API ${api}.googleapis.com is not enabled; this script never enables APIs, ask a platform engineer" ;;
    esac
  done

  # The notification channel commands are not a GA command group (SDK 587 has
  # dashboards, policies, snoozes and uptime only); they need the beta component.
  state=$(value components list --filter=id:beta '--format=value(state.name)')
  if [ "$state" = Installed ]; then
    say "ok: gcloud beta component is installed (monitoring channels)"
  else
    block "gcloud beta component is ${state:-not found} (needed by monitoring channels); run: gcloud components install beta"
  fi

  if ! has_value "Artifact Registry repository $AR_REPO" artifacts repositories describe "$AR_REPO" "--location=$REGION" "--project=$PROJECT" '--format=value(name)'; then
    block "Artifact Registry repository $AR_REPO is missing; this script never creates it"
  fi
  if ! has_value "Cloud Build connection $CONNECTION" builds connections describe "$CONNECTION" "--region=$REGION" "--project=$PROJECT" '--format=value(name)'; then
    block "Cloud Build connection $CONNECTION is missing; this script never creates it"
  fi
  for secret in "$TOKEN_SECRET" "$PROXY_KEY_SECRET"; do
    if ! has_value "secret $secret (metadata only)" secrets describe "$secret" "--project=$PROJECT" '--format=value(name)'; then
      block "secret $secret is missing; the platform owns it"
    fi
  done

  # Identities of resources that already exist must be ours, never the project's
  # default compute account. This script changes neither.
  if has_value "trigger $TRIGGER" builds triggers describe "$TRIGGER" "--region=$REGION" "--project=$PROJECT" '--format=value(name)'; then
    TRIGGER_EXISTS=1
    label=$(value builds triggers describe "$TRIGGER" "--region=$REGION" "--project=$PROJECT" '--format=value(serviceAccount)')
    if [ "$label" != "$TRIGGER_SA" ]; then
      block "trigger $TRIGGER runs as '${label:-the default Cloud Build account}', not as the build account $BUILD_SA_NAME; fix it in the Console (runbook '## Trigger from the Console'), this script does not change it"
    fi
  fi
  if has_value "Cloud Run service $SERVICE" run services describe "$SERVICE" "--region=$REGION" "--project=$PROJECT" '--format=value(metadata.name)'; then
    SERVICE_EXISTS=1
    label=$(value run services describe "$SERVICE" "--region=$REGION" "--project=$PROJECT" --format=json)
    if ! printf '%s' "$label" | grep -Eq "\"serviceAccountName\"[[:space:]]*:[[:space:]]*\"${RUNTIME_SA_EMAIL}\""; then
      block "service $SERVICE does not run as $RUNTIME_SA_NAME; this script does not change it"
    fi
  fi

  if [ "$BLOCKERS" -gt 0 ] && [ "$MODE" = apply ]; then
    echo "preflight found $BLOCKERS blocker(s); nothing was written." >&2
    exit 1
  fi
}

# ---- step 1: service accounts -----------------------------------------------
step_service_accounts() {
  local name email description
  head_line "step 1: service accounts (the description carries app=altegio-me-mcp: accounts have no labels)"
  for name in "$RUNTIME_SA_NAME" "$BUILD_SA_NAME"; do
    email="${name}@${PROJECT}.iam.gserviceaccount.com"
    if [ "$name" = "$RUNTIME_SA_NAME" ]; then
      description="app=altegio-me-mcp: runtime identity of the Cloud Run service $SERVICE"
    else
      description="app=altegio-me-mcp: Cloud Build identity that deploys the Cloud Run service $SERVICE"
    fi
    if ! has_value "service account $email" iam service-accounts describe "$email" "--project=$PROJECT" '--format=value(email)'; then
      gwrite iam service-accounts create "$name" "--display-name=$name" "--description=$description"
    fi
  done
}

# ---- step 2: secret-level access for the runtime account ---------------------
has_binding() { # $1 label, then the get-iam-policy command up to --flatten
  local label=$1 role=$2 member=$3
  shift 3
  has_value "$label" "$@" '--flatten=bindings[].members' "--filter=bindings.role:$role AND bindings.members:$member" '--format=value(bindings.members)'
}

step_secret_bindings() {
  local secret
  head_line "step 2: runtime account reads the two secrets (secret level only)"
  if [ "$SKIP_SECRET_BINDINGS" = 1 ]; then
    head_line "  skipped (--skip-secret-bindings): a platform engineer binds $TOKEN_SECRET and $PROXY_KEY_SECRET to $RUNTIME_SA_NAME"
    return 0
  fi
  for secret in "$TOKEN_SECRET" "$PROXY_KEY_SECRET"; do
    if ! has_binding "$RUNTIME_SA_NAME reads secret $secret" roles/secretmanager.secretAccessor "serviceAccount:$RUNTIME_SA_EMAIL" \
      secrets get-iam-policy "$secret" "--project=$PROJECT"; then
      gwrite secrets add-iam-policy-binding "$secret" "--member=serviceAccount:$RUNTIME_SA_EMAIL" --role=roles/secretmanager.secretAccessor
    fi
  done
}

# ---- step 3: build account roles ---------------------------------------------
step_build_roles() {
  head_line "step 3: build account roles (no secret access, no project-wide deploy rights)"
  if ! has_binding "$BUILD_SA_NAME writes logs" roles/logging.logWriter "serviceAccount:$BUILD_SA_EMAIL" \
    projects get-iam-policy "$PROJECT"; then
    gwrite projects add-iam-policy-binding "$PROJECT" "--member=serviceAccount:$BUILD_SA_EMAIL" --role=roles/logging.logWriter --condition=None
  fi
  if ! has_binding "$BUILD_SA_NAME pushes to repository $AR_REPO" roles/artifactregistry.writer "serviceAccount:$BUILD_SA_EMAIL" \
    artifacts repositories get-iam-policy "$AR_REPO" "--location=$REGION" "--project=$PROJECT"; then
    gwrite artifacts repositories add-iam-policy-binding "$AR_REPO" "--location=$REGION" "--member=serviceAccount:$BUILD_SA_EMAIL" --role=roles/artifactregistry.writer
  fi
  if ! has_binding "$BUILD_SA_NAME acts as $RUNTIME_SA_NAME" roles/iam.serviceAccountUser "serviceAccount:$BUILD_SA_EMAIL" \
    iam service-accounts get-iam-policy "$RUNTIME_SA_EMAIL" "--project=$PROJECT"; then
    gwrite iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" "--member=serviceAccount:$BUILD_SA_EMAIL" --role=roles/iam.serviceAccountUser
  fi
}

# ---- step 4: the Cloud Run service -------------------------------------------
step_service() {
  local json
  head_line "step 4: the Cloud Run service. The one allowed manual deploy: it runs only while the service is missing,"
  head_line "  from Google's placeholder image, never from our image. Every revision of our code comes from the trigger."
  if [ "$MODE" = print ]; then
    gwrite run deploy "$SERVICE" "--image=$PLACEHOLDER_IMAGE" "--region=$REGION" "--service-account=$RUNTIME_SA_EMAIL" --ingress=all --no-invoker-iam-check --max-instances=1 "--labels=$APP_LABEL" --quiet
    head_line "  when the service already exists without the invoker check disabled, only that setting is changed:"
    gwrite run services update "$SERVICE" "--region=$REGION" --no-invoker-iam-check --quiet
  elif [ "$SERVICE_EXISTS" = 1 ]; then
    json=$(value run services describe "$SERVICE" "--region=$REGION" "--project=$PROJECT" --format=json)
    if printf '%s' "$json" | grep -Eq '"run.googleapis.com/invoker-iam-disabled"[[:space:]]*:[[:space:]]*"true"'; then
      say "ok: the invoker IAM check of $SERVICE is disabled"
    else
      say "missing: the invoker IAM check of $SERVICE is still on"
      gwrite run services update "$SERVICE" "--region=$REGION" --no-invoker-iam-check --quiet
    fi
  else
    gwrite run deploy "$SERVICE" "--image=$PLACEHOLDER_IMAGE" "--region=$REGION" "--service-account=$RUNTIME_SA_EMAIL" --ingress=all --no-invoker-iam-check --max-instances=1 "--labels=$APP_LABEL" --quiet
  fi
  if ! has_binding "$BUILD_SA_NAME deploys $SERVICE" roles/run.developer "serviceAccount:$BUILD_SA_EMAIL" \
    run services get-iam-policy "$SERVICE" "--region=$REGION" "--project=$PROJECT"; then
    gwrite run services add-iam-policy-binding "$SERVICE" "--region=$REGION" "--member=serviceAccount:$BUILD_SA_EMAIL" --role=roles/run.developer
  fi
}

# ---- step 5: repository link and trigger -------------------------------------
step_trigger() {
  head_line "step 5: repository link and the deploy trigger (runs as the build account, never the default account)"
  assert_trigger_account "$TRIGGER_SA"
  if ! has_value "repository link $REPO_LINK on connection $CONNECTION" builds repositories describe "$REPO_LINK" "--connection=$CONNECTION" "--region=$REGION" "--project=$PROJECT" '--format=value(name)'; then
    gwrite builds repositories create "$REPO_LINK" "--remote-uri=$REMOTE_URI" "--connection=$CONNECTION" "--region=$REGION"
  fi
  if [ "$TRIGGER_EXISTS" = 1 ]; then
    say "ok: trigger $TRIGGER exists and runs as $BUILD_SA_NAME"
  else
    # A merge that changes only docs, markdown, workflows or scripts starts no
    # build. If this CLI form returns INVALID_ARGUMENT, use the Console (runbook).
    gwrite builds triggers create github "--name=$TRIGGER" "--repository=$REPO_PATH" '--branch-pattern=^main$' --build-config=cloudbuild.yaml \
      '--ignored-files=docs/**,**/*.md,.github/**,scripts/**' "--service-account=$TRIGGER_SA" \
      "--substitutions=_TOKEN_SECRET=$TOKEN_SECRET,_PROXY_KEY_SECRET=$PROXY_KEY_SECRET" "--region=$REGION"
  fi
}

# ---- step 6: monitoring ------------------------------------------------------
create_uptime_health() { # $1 check name, $2 period, $3 matcher content
  local host
  host=$(service_host)
  gwrite monitoring uptime create "$1" --resource-type=uptime-url "--resource-labels=host=${host:-<run-app-host>},project_id=$PROJECT" \
    --protocol=https --port=443 --path=/health --request-method=get "--period=$2" --timeout=10 "--regions=$CHECK_REGIONS" \
    --status-codes=200 "--matcher-content=$3" "--user-labels=$APP_LABEL"
}

create_uptime_public() {
  gwrite monitoring uptime create "$PUBLIC_CHECK" --resource-type=uptime-url "--resource-labels=host=mcp.alteg.io,project_id=$PROJECT" \
    --protocol=https --port=443 --path=/me --request-method=post --custom-content-type=application/json \
    '--body={"jsonrpc":"2.0","id":1,"method":"tools/list"}' '--headers=^|^Accept=application/json, text/event-stream' \
    --period=5 --timeout=10 "--regions=$CHECK_REGIONS" --status-codes=200 --matcher-content=business_get "--user-labels=$APP_LABEL"
}

metric_kind_threshold() { # $1 kind -> "threshold window"
  case "$1" in
    unauthorized) printf '3 300' ;;
    rate_limited) printf '10 600' ;;
    unavailable) printf '10 600' ;;
  esac
}

metric_kind_text() { # $1 kind -> sentence for the policy documentation
  case "$1" in
    unauthorized) printf 'Altegio refused the token (401 or 403) on at least 3 tool calls in 5 minutes. The token may have been revoked or rotated without reaching the service. See the runbook, Secret rotation.' ;;
    rate_limited) printf 'Altegio answered 429 on at least 10 tool calls in 10 minutes. The shared partner budget may be exhausted. See the runbook, Monitoring.' ;;
    unavailable) printf 'Altegio was unreachable or answered 5xx on at least 10 tool calls in 10 minutes. See the runbook, Monitoring.' ;;
  esac
}

step_monitoring() {
  local kind spec threshold window metric display check_id public_id conditions doc existing
  head_line "step 6: monitoring. One e-mail channel (the owner's); the policies below use no other channel"

  CHANNEL_REF=$(channel_ref)
  if [ -n "$CHANNEL_REF" ]; then
    say "ok: notification channel $CHANNEL_NAME"
  else
    if [ "$MODE" != print ]; then say "missing: notification channel $CHANNEL_NAME"; fi
    gwrite beta monitoring channels create "--display-name=$CHANNEL_NAME" --type=email "--channel-labels=email_address=$OWNER_EMAIL_SHOWN" "--user-labels=$APP_LABEL"
    if [ "$MODE" = apply ]; then
      CHANNEL_REF=$(channel_ref)
      if [ -z "$CHANNEL_REF" ]; then
        echo "FATAL: the channel $CHANNEL_NAME was created but cannot be listed yet; run the script again" >&2
        exit 1
      fi
    fi
  fi
  if [ -z "$CHANNEL_REF" ]; then CHANNEL_REF="projects/$PROJECT/notificationChannels/CHANNEL_ID"; fi

  check_id=$(uptime_id "$HEALTH_CHECK")
  if [ -n "$check_id" ]; then
    say "ok: uptime check $HEALTH_CHECK"
  else
    if [ "$MODE" != print ]; then say "missing: uptime check $HEALTH_CHECK"; fi
    create_uptime_health "$HEALTH_CHECK" 5 '"status":"ok"'
    if [ "$MODE" = apply ]; then check_id=$(uptime_id "$HEALTH_CHECK"); fi
  fi
  if [ -z "$check_id" ]; then check_id="CHECK_ID_OF_$HEALTH_CHECK"; fi

  public_id=''
  if [ "$PUBLIC_CHECK_ON" = 1 ]; then
    public_id=$(uptime_id "$PUBLIC_CHECK")
    if [ -n "$public_id" ]; then
      say "ok: uptime check $PUBLIC_CHECK"
    else
      if [ "$MODE" != print ]; then say "missing: uptime check $PUBLIC_CHECK"; fi
      create_uptime_public
      if [ "$MODE" = apply ]; then public_id=$(uptime_id "$PUBLIC_CHECK"); fi
    fi
    if [ -z "$public_id" ]; then public_id="CHECK_ID_OF_$PUBLIC_CHECK"; fi
  else
    head_line "  the public-route check is created only with --public-check, after the platform route is live"
  fi

  conditions=$(uptime_condition "$HEALTH_CHECK" "$check_id" 600s)
  if [ -n "$public_id" ]; then
    conditions="$conditions,
$(uptime_condition "$PUBLIC_CHECK" "$public_id" 600s)"
  fi
  doc="The service or the public route fails from more than one location for 10 minutes. See docs/runbooks/gcp-hosting.md, Monitoring."
  existing=$(policy_name "$DOWN_POLICY")
  if [ -z "$existing" ]; then
    if [ "$MODE" != print ]; then say "missing: alert policy $DOWN_POLICY"; fi
    create_policy_checked "$DOWN_POLICY" "$doc" "$conditions"
  elif [ -n "$public_id" ] && ! value monitoring policies describe "$existing" "--project=$PROJECT" '--format=value(conditions.conditionThreshold.filter)' | grep -Fq "$public_id"; then
    say "missing: the public check in alert policy $DOWN_POLICY"
    if [ "$MODE" = apply ]; then
      printf '%s\n' "$(policy_json "$DOWN_POLICY" "$doc" "$conditions")" >"$POLICY_DIR/$DOWN_POLICY.json"
    fi
    gwrite monitoring policies update "$existing" "--policy-from-file=$POLICY_DIR/$DOWN_POLICY.json"
  else
    say "ok: alert policy $DOWN_POLICY"
  fi

  for kind in unauthorized rate_limited unavailable; do
    spec=$(metric_kind_threshold "$kind")
    threshold=${spec% *}
    window=${spec#* }
    metric="altegio_me_mcp_upstream_${kind}"
    display="altegio-me-mcp-upstream-${kind//_/-}"
    if has_value "log-based metric $metric" logging metrics describe "$metric" "--project=$PROJECT" '--format=value(name)'; then
      :
    else
      gwrite logging metrics create "$metric" "--description=Tool calls of $SERVICE whose upstream failure kind is $kind (app=altegio-me-mcp)" \
        "--log-filter=resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND jsonPayload.event=\"mcp_call\" AND jsonPayload.upstream_kind=\"$kind\""
    fi
    if [ -n "$(policy_name "$display")" ]; then
      say "ok: alert policy $display"
    else
      if [ "$MODE" != print ]; then say "missing: alert policy $display"; fi
      create_policy_checked "$display" "$(metric_kind_text "$kind")" "$(metric_condition "$metric" "$threshold" "$window")"
    fi
  done
}

# create_policy_checked DISPLAY DOC CONDITIONS: builds the JSON with the owner channel.
create_policy_checked() {
  create_policy "$1" "$(policy_json "$1" "$2" "$3")"
}

# ---- step 7: read-only report ------------------------------------------------
step_report() {
  local url retention verification account
  head_line "step 7: read-only report (nothing is changed)"
  if [ "$MODE" = print ]; then
    head_line "  --plan and --apply print: the service URL, the trigger's account, the _Default log retention in days,"
    head_line "  and whether the owner's e-mail channel is verified"
    return 0
  fi
  url=$(value run services describe "$SERVICE" "--region=$REGION" "--project=$PROJECT" '--format=value(status.url)')
  say "service URL: ${url:-not created yet}"
  account=$(value builds triggers describe "$TRIGGER" "--region=$REGION" "--project=$PROJECT" '--format=value(serviceAccount)')
  say "trigger account: ${account:-not created yet}"
  retention=$(value logging buckets describe _Default --location=global "--project=$PROJECT" '--format=value(retentionDays)')
  say "_Default log retention (days): ${retention:-unknown}"
  verification=$(value beta monitoring channels list "--project=$PROJECT" "--filter=displayName=\"$CHANNEL_NAME\"" '--format=value(verificationStatus)')
  say "owner channel verification: ${verification:-unknown} (an unverified channel needs the owner to confirm a mail)"
}

# ---- the alert drill ---------------------------------------------------------
drill_delete() {
  local check_id policy
  check_id=$(uptime_id "$DRILL_CHECK")
  policy=$(policy_name "$DRILL_POLICY")
  if [ -n "$policy" ]; then
    gwrite monitoring policies delete "$policy" --quiet || echo "could not delete policy $DRILL_POLICY" >&2
  fi
  if [ -n "$check_id" ]; then
    gwrite monitoring uptime delete "$check_id" --quiet || echo "could not delete check $DRILL_CHECK" >&2
  fi
  if [ "$MODE" = print ]; then
    gwrite monitoring policies delete "projects/$PROJECT/alertPolicies/DRILL_POLICY_ID" --quiet
    gwrite monitoring uptime delete DRILL_CHECK_ID --quiet
  fi
}

iso_utc() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

# Best effort: gcloud and the Monitoring API have no list of incidents, so the
# drill prints what the check reports and links the Console for the incident.
drill_state() {
  local check_id=$1 token header end start out bad good
  token=$(gcloud auth print-access-token 2>/dev/null) || { say "  check state: no access token"; return 0; }
  header="$WORK_DIR/auth-header"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$header")
  end=$(date +%s)
  start=$((end - 180))
  out=$(curl -sS --max-time 20 -G "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" -H "@$header" \
    --data-urlencode "filter=metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$check_id\"" \
    --data-urlencode "interval.startTime=$(iso_utc "$start")" --data-urlencode "interval.endTime=$(iso_utc "$end")" 2>/dev/null) || out=''
  rm -f "$header"
  bad=$(printf '%s' "$out" | grep -c '"boolValue": false' || true)
  good=$(printf '%s' "$out" | grep -c '"boolValue": true' || true)
  say "  check state in the last 3 minutes: $bad failing samples, $good passing samples"
}

step_drill() {
  local host channel check_id n policy_doc conditions
  head_line "alert drill: a throwaway check that cannot pass and a throwaway policy on the owner's e-mail channel"
  head_line "  the real check and the real policy are not touched; both drill objects are deleted at the end"
  channel=$(channel_ref)
  if [ -z "$channel" ]; then
    if [ "$MODE" = print ]; then
      channel="projects/$PROJECT/notificationChannels/CHANNEL_ID"
    else
      echo "FATAL: the channel $CHANNEL_NAME does not exist; run the bootstrap first" >&2
      exit 1
    fi
  fi
  CHANNEL_REF=$channel
  if [ "$MODE" != print ]; then
    if [ -n "$(uptime_id "$DRILL_CHECK")" ] || [ -n "$(policy_name "$DRILL_POLICY")" ]; then
      echo "FATAL: drill leftovers exist; run --drill-cleanup first" >&2
      exit 1
    fi
  fi
  host=$(service_host)
  gwrite monitoring uptime create "$DRILL_CHECK" --resource-type=uptime-url "--resource-labels=host=${host:-<run-app-host>},project_id=$PROJECT" \
    --protocol=https --port=443 --path=/health --request-method=get --period=1 --timeout=10 "--regions=$CHECK_REGIONS" \
    --status-codes=200 --matcher-content=drill-content-that-never-appears "--user-labels=$APP_LABEL"
  if [ "$MODE" = apply ]; then DRILL_ACTIVE=1; fi
  check_id=$(uptime_id "$DRILL_CHECK")
  if [ -z "$check_id" ]; then check_id="CHECK_ID_OF_$DRILL_CHECK"; fi
  conditions=$(uptime_condition "$DRILL_CHECK" "$check_id" 60s)
  policy_doc="Alert drill. This policy and its check are throwaway and are deleted after the drill."
  create_policy "$DRILL_POLICY" "$(policy_json "$DRILL_POLICY" "$policy_doc" "$conditions")"
  if [ "$MODE" = apply ]; then
    n=0
    say "waiting up to $DRILL_MAX_POLLS poll(s) of ${DRILL_POLL_SECONDS}s for the incident and the e-mail"
    say "incidents: https://console.cloud.google.com/monitoring/alerting/incidents?project=$PROJECT"
    while [ "$n" -lt "$DRILL_MAX_POLLS" ]; do
      n=$((n + 1))
      if [ -t 0 ]; then
        say "minute $n: press Enter once the e-mail arrived to end the drill early"
        if read -r -t "$DRILL_POLL_SECONDS" _answer; then break; fi
      else
        sleep "$DRILL_POLL_SECONDS"
      fi
      say "poll $n of $DRILL_MAX_POLLS"
      drill_state "$check_id"
    done
    DRILL_ACTIVE=0
    drill_delete
    say "drill finished; confirm that the e-mail arrived and that the incident closed after the delete"
  else
    head_line "  then up to $DRILL_MAX_POLLS polls of ${DRILL_POLL_SECONDS}s, and the delete:"
    drill_delete
  fi
}

step_cleanup() {
  head_line "drill cleanup: delete leftovers of the drill check and policy"
  drill_delete
}

# ---- main --------------------------------------------------------------------
main() {
  case "$ACTION" in
    drill) step_drill ;;
    cleanup) step_cleanup ;;
    bootstrap)
      head_line "altegio-me-mcp bootstrap in project $PROJECT, region $REGION, mode $MODE"
      if [ "$MODE" = print ]; then
        head_line "every write the script would make, in order; nothing is run and gcloud is not called"
      fi
      preflight
      step_service_accounts
      step_secret_bindings
      step_build_roles
      step_service
      step_trigger
      step_monitoring
      step_report
      ;;
  esac
  if [ "$MODE" = plan ]; then
    say "plan: $PENDING write(s) pending, $BLOCKERS blocker(s)"
    if [ "$BLOCKERS" -gt 0 ]; then exit 1; fi
  fi
  if [ "$MODE" = apply ] && [ "$ACTION" = bootstrap ]; then
    say "apply finished"
  fi
}

main
