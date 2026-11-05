#!/usr/bin/env bash
# Container smoke test: scripts/smoke.sh IMAGE
# Runs the image with a canary token and a proxy key file, and checks /health
# (version and the COMMIT_SHA the container was given), the stateless /mcp
# endpoint with requests signed the way the platform proxy signs them, the 401
# for an unsigned request, the in-band refusal of me_list_places for a signed
# client identity without the mcp:me:read scope (ME-01), that no secret
# reaches the logs or the image config (the canary user token included), the
# container user and the SIGTERM shutdown.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/smoke.sh IMAGE" >&2
  exit 2
fi

IMAGE="$1"
NAME="altegio-me-mcp-smoke-$$"
HOST_PORT="${SMOKE_HOST_PORT:-0}"
BASE_URL="http://localhost:${HOST_PORT}"
NETWORK_ARGS=(--network bridge)
if [ -n "${SMOKE_NETWORK:-}" ]; then
  NETWORK_ARGS=(--network "$SMOKE_NETWORK")
  BASE_URL="http://${NAME}:8080"
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANARY_TOKEN="smoke-token-$(date +%s)-$RANDOM"
CANARY_ARG="smoke-arg-$RANDOM"
CANARY_USER_TOKEN="smoke-user-$RANDOM-$(date +%s)"
WORK_DIR="$(mktemp -d)"
# Random per run; the container reads it from a file, as production reads the
# Secret Manager mount. The verifier takes the text of the key as the HMAC key.
PROXY_KEY="$(openssl rand -hex 32)"
PROXY_KEY_FILE="$WORK_DIR/proxy-key"
COMMIT_VALUE="0123abc"

cleanup() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if docker inspect "$NAME" >/dev/null 2>&1; then
    echo "Container retained only until cleanup; raw logs are not printed." >&2
  fi
  exit 1
}

# sign_post_mcp [NAME:VALUE...]: the x-mcp-proxy-auth value for POST /mcp now
# (research Pattern 1): v1:<seconds>:<hex HMAC-SHA256> over 'mcp-proxy-auth/v1',
# the seconds, the method and the path, then one name:value line per x-mcp-auth-*
# header, all joined by newlines. The identity lines are given already sorted by
# name; with none, no x-mcp-auth-* header is sent.
sign_post_mcp() {
  local seconds mac line text
  seconds="$(date +%s)"
  text="$(printf 'mcp-proxy-auth/v1\n%s\nPOST\n/mcp' "$seconds")"
  for line in "$@"; do
    text="$(printf '%s\n%s' "$text" "$line")"
  done
  mac="$(printf '%s' "$text" |
    openssl dgst -sha256 -hmac "$PROXY_KEY" |
    sed 's/^.*= //')"
  printf 'v1:%s:%s' "$seconds" "$mac"
}

# post_mcp NAME JSON: signed POST to /mcp, keep headers in
# $WORK_DIR/NAME.headers and the body in $WORK_DIR/NAME.body, print the HTTP
# status.
post_mcp() {
  curl -sS -D "$WORK_DIR/$1.headers" -o "$WORK_DIR/$1.body" -w '%{http_code}' \
    -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "x-mcp-proxy-auth: $(sign_post_mcp)" \
    --data "$2"
}

# post_mcp_client NAME JSON: signed POST to /mcp with the identity of a signed-in
# client (x-mcp-auth-kind client and the canary user token), and no
# x-mcp-auth-scope header. The identity lines are sorted by header name.
post_mcp_client() {
  curl -sS -D "$WORK_DIR/$1.headers" -o "$WORK_DIR/$1.body" -w '%{http_code}' \
    -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "x-mcp-auth-altegio-user-token: $CANARY_USER_TOKEN" \
    -H 'x-mcp-auth-kind: client' \
    -H "x-mcp-proxy-auth: $(sign_post_mcp \
      "x-mcp-auth-altegio-user-token:$CANARY_USER_TOKEN" \
      'x-mcp-auth-kind:client')" \
    --data "$2"
}

# post_mcp_unsigned NAME JSON: the same request without the signature header.
post_mcp_unsigned() {
  curl -sS -D "$WORK_DIR/$1.headers" -o "$WORK_DIR/$1.body" -w '%{http_code}' \
    -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$2"
}

EXPECTED_VERSION="$(jq -r .version "$ROOT/package.json")"

# The image declares no variable whose name suggests a secret: secrets reach a
# container at run time only (SEC-03, OPS-04). Names only, never values.
SECRET_NAME_PATTERN='TOKEN|SECRET|KEY|PASSWORD'
image_env_names="$(docker inspect --format '{{json .Config.Env}}' "$IMAGE" |
  jq -r '.[]? | split("=")[0]')"
if secret_named="$(grep -Ei "$SECRET_NAME_PATTERN" <<<"$image_env_names")"; then
  fail "the image config declares a secret-named variable: $(tr '\n' ' ' <<<"$secret_named")"
fi

# The key file is copied into the container instead of bind-mounted: a bind
# mount of a macOS temp directory is not visible under Colima. Mode 0644 so the
# non-root node user can read it.
printf '%s' "$PROXY_KEY" >"$PROXY_KEY_FILE"
chmod 0644 "$PROXY_KEY_FILE"

docker rm -fv "$NAME" >/dev/null 2>&1 || true
docker create --read-only --mount type=volume,destination=/tmp --name "$NAME" "${NETWORK_ARGS[@]}" -p "127.0.0.1:${HOST_PORT}:8080" \
  -e PORT=8080 \
  -e ALTEGIO_API_TOKEN="$CANARY_TOKEN" \
  -e PUBLIC_BASE_URL="$BASE_URL" \
  -e LOG_LEVEL=info \
  -e MCP_PROXY_BACKEND_KEY_FILE=/tmp/proxy-key \
  -e CALLER_AUTH=optional \
  -e COMMIT_SHA="$COMMIT_VALUE" \
  "$IMAGE" >/dev/null
docker cp "$PROXY_KEY_FILE" "$NAME:/tmp/proxy-key"
docker start "$NAME" >/dev/null
if [ -z "${SMOKE_NETWORK:-}" ]; then
  HOST_PORT="$(docker port "$NAME" 8080/tcp | awk -F: 'NR == 1 {print $NF}')"
  BASE_URL="http://127.0.0.1:${HOST_PORT}"
fi

# Wait for /health (30 seconds at most).
ready=0
for _ in $(seq 1 30); do
  if curl -fsS "$BASE_URL/health" -o "$WORK_DIR/health.json" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "/health did not answer within 30 seconds"

jq -e '.status == "ok"' "$WORK_DIR/health.json" >/dev/null ||
  fail "/health status is not ok: $(cat "$WORK_DIR/health.json")"
jq -e --arg v "$EXPECTED_VERSION" '.version == $v' "$WORK_DIR/health.json" >/dev/null ||
  fail "/health version is not $EXPECTED_VERSION: $(cat "$WORK_DIR/health.json")"
jq -e --arg c "$COMMIT_VALUE" '.commit == $c' "$WORK_DIR/health.json" >/dev/null ||
  fail "/health commit is not $COMMIT_VALUE: $(cat "$WORK_DIR/health.json")"

# initialize: 200, a protocol version, no session header (stateless server).
init_status="$(post_mcp initialize '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}')"
[ "$init_status" = "200" ] || fail "initialize returned HTTP $init_status"
jq -e '.result.protocolVersion' "$WORK_DIR/initialize.body" >/dev/null ||
  fail "initialize has no result.protocolVersion: $(cat "$WORK_DIR/initialize.body")"
if grep -qi '^mcp-session-id:' "$WORK_DIR/initialize.headers"; then
  fail "initialize response carries an mcp-session-id header"
fi

# tools/list: 200, tools is an array, no session header.
list_status="$(post_mcp tools-list '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
[ "$list_status" = "200" ] || fail "tools/list returned HTTP $list_status"
jq -e '.result.tools | type == "array"' "$WORK_DIR/tools-list.body" >/dev/null ||
  fail "tools/list result.tools is not an array: $(cat "$WORK_DIR/tools-list.body")"
if grep -qi '^mcp-session-id:' "$WORK_DIR/tools-list.headers"; then
  fail "tools/list response carries an mcp-session-id header"
fi

# tools/call with an unknown tool: a JSON-RPC error, and the argument value
# must never reach the logs.
call_body="$(jq -nc --arg q "$CANARY_ARG" '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"smoke_unknown_tool",arguments:{q:$q}}}')"
post_mcp call "$call_body" >/dev/null
jq -e '.error' "$WORK_DIR/call.body" >/dev/null ||
  fail "tools/call with an unknown tool returned no JSON-RPC error: $(cat "$WORK_DIR/call.body")"

# A signed client identity without mcp:me:read: HTTP 200 and an in-band refusal
# of me_list_places that names the sign-in (ME-01). Nothing reaches Altegio, so
# the canary user token goes nowhere but the log scan below.
me_body="$(jq -nc '{jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"me_list_places",arguments:{}}}')"
me_status="$(post_mcp_client me-refusal "$me_body")"
[ "$me_status" = "200" ] || fail "me_list_places for a client without mcp:me:read returned HTTP $me_status, expected 200"
jq -e '.result.isError == true' "$WORK_DIR/me-refusal.body" >/dev/null ||
  fail "me_list_places for a client without mcp:me:read is not an in-band refusal: $(cat "$WORK_DIR/me-refusal.body")"
jq -e '.result.content[0].text | contains("sign-in")' "$WORK_DIR/me-refusal.body" >/dev/null ||
  fail "the me_list_places refusal does not name the sign-in: $(cat "$WORK_DIR/me-refusal.body")"
if grep -qF "$CANARY_USER_TOKEN" "$WORK_DIR/me-refusal.body"; then
  fail "the canary user token appears in the me_list_places refusal"
fi

# An unsigned request is refused before its body is read: 401 and the fixed
# proxy_auth_required body (OPS-03, D-04).
unsigned_status="$(post_mcp_unsigned unsigned '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')"
[ "$unsigned_status" = "401" ] || fail "an unsigned POST /mcp returned HTTP $unsigned_status, expected 401"
jq -e '.error == "proxy_auth_required"' "$WORK_DIR/unsigned.body" >/dev/null ||
  fail "the unsigned refusal has no proxy_auth_required error: $(cat "$WORK_DIR/unsigned.body")"

# HTTPS terminates at a controlled trusted proxy, which signs to the production
# backend as Cloud Run ingress/platform do. Trust this run's certificate only.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost' \
  -keyout "$WORK_DIR/fixture-key.pem" -out "$WORK_DIR/fixture-cert.pem" >/dev/null 2>&1
chmod 0644 "$WORK_DIR/fixture-key.pem" "$WORK_DIR/fixture-cert.pem"
docker cp "$WORK_DIR/fixture-key.pem" "$NAME:/tmp/fixture-key.pem"
docker cp "$WORK_DIR/fixture-cert.pem" "$NAME:/tmp/fixture-cert.pem"
docker cp "$ROOT/scripts/https-smoke.mjs" "$NAME:/tmp/https-smoke.mjs"
docker exec -e VERIFY_UNSIGNED=0 "$NAME" node /tmp/https-smoke.mjs || fail 'signed HTTPS protocol fixture failed'

# The container runs as the node user, not root.
configured_user="$(docker inspect --format '{{.Config.User}}' "$NAME")"
[ "$configured_user" = "node" ] || fail "container user is '$configured_user', expected node"

# SIGTERM: stop within the 10 second window and exit with code 0.
stop_started="$(date +%s)"
docker stop -t 10 "$NAME" >/dev/null
stop_finished="$(date +%s)"
stop_seconds=$((stop_finished - stop_started))
[ "$stop_seconds" -lt 10 ] || fail "docker stop took ${stop_seconds}s (limit: under 10s)"
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$NAME")"
[ "$exit_code" = "0" ] || fail "container exit code is $exit_code, expected 0"

# Logs: exactly one mcp_call line per POST (six signed, one unsigned), the
# unsigned one with its auth_reason, no canary token, no canary user token, no
# canary key, no canary argument.
docker logs "$NAME" >"$WORK_DIR/container.log" 2>&1
call_lines="$(grep -c '"event":"mcp_call"' "$WORK_DIR/container.log" || true)"
[ "$call_lines" = "7" ] || fail "expected 7 mcp_call log lines, found $call_lines"
refusal_lines="$(grep -c '"auth_reason":"missing"' "$WORK_DIR/container.log" || true)"
[ "$refusal_lines" -ge "1" ] || fail "expected at least 1 log line with auth_reason missing, found $refusal_lines"
if grep -qF "$CANARY_TOKEN" "$WORK_DIR/container.log"; then
  fail "the canary token appears in the container logs"
fi
if grep -qF "$CANARY_USER_TOKEN" "$WORK_DIR/container.log"; then
  fail "the canary user token appears in the container logs"
fi
if grep -qF "$PROXY_KEY" "$WORK_DIR/container.log"; then
  fail "the canary proxy key appears in the container logs"
fi
if grep -qF "$CANARY_ARG" "$WORK_DIR/container.log"; then
  fail "the canary tool argument appears in the container logs"
fi

echo "PASS smoke: image=$IMAGE version=$EXPECTED_VERSION mcp_call_lines=$call_lines refusal_lines=$refusal_lines user=$configured_user stop=${stop_seconds}s exit=$exit_code"
