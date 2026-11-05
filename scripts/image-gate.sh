#!/usr/bin/env bash
# Mandatory release image gate. Works with Cloud Build's Docker daemon without
# assuming localhost port forwarding or tools installed in the builder image.
set -euo pipefail
IMAGE="$1"
NAME="me-gate-${BUILD_ID:-$$}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
cleanup() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

docker run --rm --entrypoint node "$IMAGE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$WORK_DIR/proxy-key"
chmod 0644 "$WORK_DIR/proxy-key"
docker create --read-only --mount type=volume,destination=/tmp --name "$NAME" \
  -e ALTEGIO_API_TOKEN=image-gate-canary-token \
  -e PUBLIC_BASE_URL=https://fixture.invalid/me \
  -e MCP_PROXY_BACKEND_KEY_FILE=/tmp/proxy-key \
  -e CALLER_AUTH=optional \
  -e COMMIT_SHA=0123abc "$IMAGE" >/dev/null
docker cp "$WORK_DIR/proxy-key" "$NAME:/tmp/proxy-key"
docker cp "$ROOT/scripts/fixtures/localhost-cert.pem" "$NAME:/tmp/fixture-cert.pem"
docker cp "$ROOT/scripts/fixtures/localhost-key.pem" "$NAME:/tmp/fixture-key.pem"
docker cp "$ROOT/scripts/https-smoke.mjs" "$NAME:/tmp/https-smoke.mjs"
docker start "$NAME" >/dev/null
docker exec "$NAME" node /tmp/https-smoke.mjs
# Never dump container logs on failure: CI has independent redaction checks.
