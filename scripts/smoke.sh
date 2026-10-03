#!/usr/bin/env bash
# Container smoke test: scripts/smoke.sh IMAGE
# Runs the image with a canary token and checks /health, the stateless /mcp
# endpoint, the log contents, the container user and the SIGTERM shutdown.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/smoke.sh IMAGE" >&2
  exit 2
fi

IMAGE="$1"
NAME="altegio-me-mcp-smoke"
HOST_PORT=18080
BASE_URL="http://localhost:${HOST_PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANARY_TOKEN="smoke-token-$(date +%s)-$RANDOM"
CANARY_ARG="smoke-arg-$RANDOM"
WORK_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if docker inspect "$NAME" >/dev/null 2>&1; then
    echo "--- container logs ---" >&2
    docker logs "$NAME" >&2 2>&1 || true
  fi
  exit 1
}

# post_mcp NAME JSON: POST to /mcp, keep headers in $WORK_DIR/NAME.headers and
# the body in $WORK_DIR/NAME.body, print the HTTP status.
post_mcp() {
  curl -sS -D "$WORK_DIR/$1.headers" -o "$WORK_DIR/$1.body" -w '%{http_code}' \
    -X POST "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$2"
}

EXPECTED_VERSION="$(jq -r .version "$ROOT/package.json")"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "${HOST_PORT}:8080" \
  -e PORT=8080 \
  -e ALTEGIO_API_TOKEN="$CANARY_TOKEN" \
  -e PUBLIC_BASE_URL="$BASE_URL" \
  -e LOG_LEVEL=info \
  "$IMAGE" >/dev/null

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

# Logs: exactly one mcp_call line per POST, no canary token, no canary argument.
docker logs "$NAME" >"$WORK_DIR/container.log" 2>&1
call_lines="$(grep -c '"event":"mcp_call"' "$WORK_DIR/container.log" || true)"
[ "$call_lines" = "3" ] || fail "expected 3 mcp_call log lines, found $call_lines"
if grep -qF "$CANARY_TOKEN" "$WORK_DIR/container.log"; then
  fail "the canary token appears in the container logs"
fi
if grep -qF "$CANARY_ARG" "$WORK_DIR/container.log"; then
  fail "the canary tool argument appears in the container logs"
fi

echo "PASS smoke: image=$IMAGE version=$EXPECTED_VERSION mcp_call_lines=$call_lines user=$configured_user stop=${stop_seconds}s exit=$exit_code"
