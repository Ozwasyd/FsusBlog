#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATEWAY_CONFIG="${FSUSBLOG_GATEWAY_CONFIG_UNDER_TEST:-$ROOT_DIR/ops/gateway/production-openresty.conf}"
GATEWAY_IMAGE="${FSUSBLOG_GATEWAY_SYNTAX_IMAGE:-nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b}"
TEMP_DIR="$(mktemp -d)"

Cleanup() {
    rm -rf -- "$TEMP_DIR"
}
trap Cleanup EXIT

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' '[production-gateway] docker is required' >&2
    exit 1
}
command -v openssl >/dev/null 2>&1 || {
    printf '%s\n' '[production-gateway] openssl is required' >&2
    exit 1
}
[[ -f "$GATEWAY_CONFIG" && ! -L "$GATEWAY_CONFIG" ]] || {
    printf '%s\n' '[production-gateway] gateway config must be a regular non-symlink file' >&2
    exit 1
}
[[ "$GATEWAY_IMAGE" == *@sha256:* ]] || {
    printf '%s\n' '[production-gateway] syntax image must be pinned by manifest digest' >&2
    exit 1
}

mkdir -p "$TEMP_DIR/letsencrypt/live/fsus.blog" "$TEMP_DIR/fsusblog"
cp "$ROOT_DIR/ops/gateway/active-upstream.conf.example" \
    "$TEMP_DIR/fsusblog/active-upstream.conf"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj '/CN=fsus.blog' \
    -keyout "$TEMP_DIR/letsencrypt/live/fsus.blog/privkey.pem" \
    -out "$TEMP_DIR/letsencrypt/live/fsus.blog/fullchain.pem" \
    >/dev/null 2>&1

docker run --rm --read-only \
    --entrypoint nginx \
    --tmpfs /var/cache/nginx:rw,noexec,nosuid,size=16m \
    --tmpfs /var/run:rw,noexec,nosuid,size=1m \
    --tmpfs /tmp:rw,noexec,nosuid,size=1m \
    --mount "type=bind,src=$GATEWAY_CONFIG,dst=/etc/nginx/nginx.conf,readonly" \
    --mount "type=bind,src=$TEMP_DIR/fsusblog,dst=/etc/openresty/fsusblog,readonly" \
    --mount "type=bind,src=$TEMP_DIR/letsencrypt,dst=/etc/letsencrypt,readonly" \
    "$GATEWAY_IMAGE" \
    -t -c /etc/nginx/nginx.conf

printf '[production-gateway] syntax verified with %s\n' "$GATEWAY_IMAGE"
