#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/ops/docker/docker-compose.yml"
GATEWAY_FILE="$ROOT_DIR/deploy/production-openresty.conf"
ENV_TEMPLATE="$ROOT_DIR/.env.production-template"

failures=()

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    failures+=("missing file: ${file#$ROOT_DIR/}")
  fi
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -Eq "$pattern" "$file"; then
    failures+=("${file#$ROOT_DIR/}: missing $label")
  fi
}

reject_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -Eq "$pattern" "$file"; then
    failures+=("${file#$ROOT_DIR/}: forbidden $label")
  fi
}

require_file "$COMPOSE_FILE"
require_file "$GATEWAY_FILE"
require_file "$ENV_TEMPLATE"

if [[ -f "$COMPOSE_FILE" ]]; then
  require_pattern "$COMPOSE_FILE" '127\.0\.0\.1:8080:8080' 'loopback-only Kestrel port binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])8080:8080(["[:space:]]|$)' 'public Kestrel 8080 binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])6379:6379(["[:space:]]|$)' 'public Redis port binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])5432:5432(["[:space:]]|$)' 'public PostgreSQL port binding'
  require_pattern "$COMPOSE_FILE" 'AllowedHosts=\$\{APP_ALLOWED_HOSTS\}' 'AllowedHosts production environment binding'
  require_pattern "$COMPOSE_FILE" 'ReverseProxy__KnownProxies=' 'reverse proxy known proxies binding'
fi

if [[ -f "$GATEWAY_FILE" ]]; then
  require_pattern "$GATEWAY_FILE" 'server_name[[:space:]]+_;' 'default unknown Host server'
  require_pattern "$GATEWAY_FILE" 'return[[:space:]]+444;' 'unknown Host rejection'
  require_pattern "$GATEWAY_FILE" 'limit_req_zone' 'request rate limit zones'
  require_pattern "$GATEWAY_FILE" 'limit_conn_zone' 'connection limit zone'
  require_pattern "$GATEWAY_FILE" 'location[[:space:]]+~[[:space:]]+/\\\.\(\?!well-known\)' 'hidden file deny rule'
  require_pattern "$GATEWAY_FILE" '\\\.\(bak\|old\|orig\|save\|sql\|tar\|gz\|zip\|7z\|rar\)' 'backup/archive deny rule'
  require_pattern "$GATEWAY_FILE" 'client_max_body_size[[:space:]]+5m;' 'explicit upload limit'
  require_pattern "$GATEWAY_FILE" 'proxy_set_header[[:space:]]+Upgrade[[:space:]]+\$http_upgrade;' 'WebSocket upgrade forwarding'
  require_pattern "$GATEWAY_FILE" 'proxy_buffering[[:space:]]+off;' 'WebSocket buffering disabled'
  require_pattern "$GATEWAY_FILE" 'Strict-Transport-Security' 'HSTS response header'
fi

if [[ -f "$ENV_TEMPLATE" ]]; then
  require_pattern "$ENV_TEMPLATE" '^APP_ALLOWED_HOSTS=' 'AllowedHosts template variable'
  require_pattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_PROXIES=' 'reverse proxy known proxies template variable'
  require_pattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_NETWORKS=' 'reverse proxy known networks template variable'
fi

if [[ "${FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST:-0}" != "1" ]]; then
  "$ROOT_DIR/tools/security/check-production-exposure-prereqs.sh"
  "$ROOT_DIR/tools/security/test-production-exposure-tools.sh"
fi

if (( ${#failures[@]} > 0 )); then
  printf '[production-network-baseline] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-network-baseline] ok\n'
