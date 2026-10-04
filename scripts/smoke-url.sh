#!/usr/bin/env bash
# Smoke test of a deployed URL. curl only, no jq: Cloud Build runs it inside the
# cloud-sdk image, and an operator can run it from any laptop.
#
#   scripts/smoke-url.sh BASE_URL EXPECTED_COMMIT
#     run.app mode, used by cloudbuild.yaml on the tagged revision before it
#     takes traffic. Polls GET /health for 30 seconds, then requires 200,
#     "status":"ok" and "commit":"EXPECTED_COMMIT"; and requires an unsigned
#     POST /mcp to be refused with 401 proxy_auth_required (the proxy check is
#     on, so the revision cannot be called around the platform proxy).
#
#   scripts/smoke-url.sh --public URL
#     public mode, run by hand once the platform proxy route exists. URL is the
#     public MCP address (https://mcp.alteg.io/me); the proxy maps it to /mcp.
#     Requires initialize and tools/list to answer 200, a tools list with
#     business_get, no mcp-session-id header and no redirect, and the
#     protected-resource metadata route under the same host to be 404.
set -euo pipefail

usage() {
  echo "usage: scripts/smoke-url.sh BASE_URL EXPECTED_COMMIT" >&2
  echo "       scripts/smoke-url.sh --public URL" >&2
  exit 2
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# request NAME METHOD URL [curl args...]: keep headers in $WORK_DIR/NAME.headers
# and the body in $WORK_DIR/NAME.body, print the HTTP status ("000" when the
# connection failed). No redirect is followed, so a 3xx stays visible.
request() {
  local name="$1" method="$2" url="$3"
  shift 3
  curl -sS -o "$WORK_DIR/$name.body" -D "$WORK_DIR/$name.headers" \
    -w '%{http_code}' --max-time 20 -X "$method" "$@" "$url" 2>/dev/null || echo "000"
}

MCP_HEADERS=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke-url","version":"0.0.0"}}}'
LIST_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

run_app_mode() {
  local base="${1%/}" expected="$2"
  [ -n "$base" ] && [ -n "$expected" ] || usage

  # /health, polled: a tagged revision may still be cold.
  local status="000" waited=0
  while [ "$waited" -lt 30 ]; do
    status="$(request health GET "$base/health")"
    [ "$status" = "200" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  [ "$status" = "200" ] || fail "GET $base/health returned HTTP $status after ${waited}s"
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$WORK_DIR/health.body" ||
    fail "/health status is not ok: $(cat "$WORK_DIR/health.body")"
  grep -Eq "\"commit\"[[:space:]]*:[[:space:]]*\"$expected\"" "$WORK_DIR/health.body" ||
    fail "/health commit is not $expected: $(cat "$WORK_DIR/health.body")"

  # The proxy check is on: an unsigned call is refused before its body is read.
  status="$(request unsigned POST "$base/mcp" "${MCP_HEADERS[@]}" --data "$LIST_BODY")"
  [ "$status" = "401" ] || fail "an unsigned POST $base/mcp returned HTTP $status, expected 401"
  grep -Fq 'proxy_auth_required' "$WORK_DIR/unsigned.body" ||
    fail "the unsigned refusal has no proxy_auth_required error: $(cat "$WORK_DIR/unsigned.body")"

  echo "PASS smoke-url: mode=run.app url=$base commit=$expected"
}

run_public_mode() {
  local url="${1%/}"
  [ -n "$url" ] || usage
  local origin
  origin="$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*$#\1#')"

  local status
  status="$(request initialize POST "$url" "${MCP_HEADERS[@]}" --data "$INIT_BODY")"
  case "$status" in
    3??) fail "initialize on $url was redirected (HTTP $status); the route must answer directly" ;;
  esac
  [ "$status" = "200" ] || fail "initialize on $url returned HTTP $status"
  grep -Fq 'protocolVersion' "$WORK_DIR/initialize.body" ||
    fail "initialize has no protocolVersion: $(cat "$WORK_DIR/initialize.body")"
  if grep -qi '^mcp-session-id:' "$WORK_DIR/initialize.headers"; then
    fail "initialize response carries an mcp-session-id header"
  fi

  status="$(request tools-list POST "$url" "${MCP_HEADERS[@]}" --data "$LIST_BODY")"
  case "$status" in
    3??) fail "tools/list on $url was redirected (HTTP $status); the route must answer directly" ;;
  esac
  [ "$status" = "200" ] || fail "tools/list on $url returned HTTP $status"
  grep -Fq '"tools"' "$WORK_DIR/tools-list.body" ||
    fail "tools/list has no tools array: $(cat "$WORK_DIR/tools-list.body")"
  grep -Fq 'business_get' "$WORK_DIR/tools-list.body" ||
    fail "tools/list does not list business_get: $(cat "$WORK_DIR/tools-list.body")"
  if grep -qi '^mcp-session-id:' "$WORK_DIR/tools-list.headers"; then
    fail "tools/list response carries an mcp-session-id header"
  fi

  # The server is a stateless resource server with no OAuth in v1: the
  # protected-resource metadata route must not exist behind the proxy.
  status="$(request metadata GET "$origin/.well-known/oauth-protected-resource/me")"
  [ "$status" = "404" ] ||
    fail "GET $origin/.well-known/oauth-protected-resource/me returned HTTP $status, expected 404"

  echo "PASS smoke-url: mode=public url=$url"
}

case "${1:-}" in
  --public)
    [ "$#" -eq 2 ] || usage
    run_public_mode "$2"
    ;;
  -*)
    usage
    ;;
  *)
    [ "$#" -eq 2 ] || usage
    run_app_mode "$1" "$2"
    ;;
esac
