#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/ops/docker/docker-compose.production.yml"
GATEWAY_FILE="$ROOT_DIR/ops/gateway/production-openresty.conf"
GATEWAY_UPSTREAM_EXAMPLE="$ROOT_DIR/ops/gateway/active-upstream.conf.example"
ENV_TEMPLATE="$ROOT_DIR/.env.production.example"

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
require_file "$GATEWAY_UPSTREAM_EXAMPLE"
require_file "$ENV_TEMPLATE"

if [[ -f "$COMPOSE_FILE" ]]; then
  require_pattern "$COMPOSE_FILE" '127\.0\.0\.1:\$\{FSUSBLOG_SLOT_PORT:\?[^}]+\}:8080' 'slot-parameterized loopback-only Kestrel port binding'
  require_pattern "$COMPOSE_FILE" 'container_name:[[:space:]]+\$\{FSUSBLOG_CONTAINER_NAME:\?' 'slot-specific container identity'
  require_pattern "$COMPOSE_FILE" 'FSUSBLOG_SHARED_UPLOADS_VOLUME:\?' 'explicit shared uploads volume'
  require_pattern "$COMPOSE_FILE" 'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:\?' 'explicit shared DataProtection volume'
  reject_pattern "$COMPOSE_FILE" '127\.0\.0\.1:8080:8080' 'retired single-slot Kestrel binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])8080:8080(["[:space:]]|$)' 'public Kestrel 8080 binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])6379:6379(["[:space:]]|$)' 'public Redis port binding'
  reject_pattern "$COMPOSE_FILE" '(^|["[:space:]])5432:5432(["[:space:]]|$)' 'public PostgreSQL port binding'
  require_pattern "$COMPOSE_FILE" 'AllowedHosts=\$\{APP_ALLOWED_HOSTS\}' 'AllowedHosts production environment binding'
  require_pattern "$COMPOSE_FILE" 'ReverseProxy__KnownProxies=' 'reverse proxy known proxies binding'
  require_pattern "$COMPOSE_FILE" 'DOTNET_DbgEnableMiniDump=0' 'managed dump disablement'
  require_pattern "$COMPOSE_FILE" 'COMPlus_DbgEnableMiniDump=0' 'legacy managed dump disablement'
  require_pattern "$COMPOSE_FILE" 'DOTNET_EnableDiagnostics=0' 'production diagnostic port disablement'
  require_pattern "$COMPOSE_FILE" 'cap_drop:' 'container capability drop policy'
  require_pattern "$COMPOSE_FILE" '^[[:space:]]+-[[:space:]]+ALL[[:space:]]*$' 'all Linux capabilities dropped'
  require_pattern "$COMPOSE_FILE" 'no-new-privileges:true' 'no-new-privileges policy'
  require_pattern "$COMPOSE_FILE" 'ulimits:' 'container ulimit policy'
  require_pattern "$COMPOSE_FILE" '^[[:space:]]+core:[[:space:]]*$' 'core dump ulimit'
  require_pattern "$COMPOSE_FILE" '^[[:space:]]+soft:[[:space:]]+0[[:space:]]*$' 'core dump soft limit zero'
  require_pattern "$COMPOSE_FILE" '^[[:space:]]+hard:[[:space:]]+0[[:space:]]*$' 'core dump hard limit zero'
  reject_pattern "$COMPOSE_FILE" '(DOTNET_DbgEnableMiniDump|COMPlus_DbgEnableMiniDump|DOTNET_EnableDiagnostics)=[1-9]' 'enabled production dump or diagnostic switch'
  reject_pattern "$COMPOSE_FILE" '^[[:space:]]+(soft|hard):[[:space:]]+(-1|unlimited)[[:space:]]*$' 'unlimited core dump policy'
fi

if [[ -f "$GATEWAY_FILE" ]]; then
  require_pattern "$GATEWAY_FILE" 'include[[:space:]]+/etc/openresty/fsusblog/active-upstream\.conf;' 'controlled dynamic active upstream include'
  reject_pattern "$GATEWAY_FILE" 'server[[:space:]]+127\.0\.0\.1:8080;' 'retired fixed application upstream'
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

if [[ -f "$GATEWAY_UPSTREAM_EXAMPLE" ]]; then
  require_pattern "$GATEWAY_UPSTREAM_EXAMPLE" '^server[[:space:]]+127\.0\.0\.1:808[12];$' 'single controlled blue/green loopback server'
  reject_pattern "$GATEWAY_UPSTREAM_EXAMPLE" 'server[[:space:]]+(0\.0\.0\.0|::|10\.|172\.|192\.168\.|[A-Za-z])' 'non-loopback or hostname upstream'
  if [[ "$(wc -l < "$GATEWAY_UPSTREAM_EXAMPLE")" -ne 1 ]]; then
    failures+=("ops/gateway/active-upstream.conf.example: must contain exactly one generated server line")
  fi
fi

if [[ -f "$ENV_TEMPLATE" ]]; then
  require_pattern "$ENV_TEMPLATE" '^APP_ALLOWED_HOSTS=' 'AllowedHosts template variable'
  require_pattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_PROXIES=' 'reverse proxy known proxies template variable'
  require_pattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_NETWORKS=' 'reverse proxy known networks template variable'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_BLUE_PORT=8081$' 'blue loopback port'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_GREEN_PORT=8082$' 'green loopback port'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_SLOT_STATE_FILE=/var/lib/fsusblog/deployment/slots\.json$' 'durable slot state path'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_DEPLOYMENT_LOCK_FILE=/var/lock/fsusblog-deployment\.lock$' 'shared deployment lock path'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM=/etc/openresty/fsusblog/active-upstream\.conf$' 'controlled active upstream path'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_CONFIG_FILE=/etc/openresty/nginx\.conf$' 'complete OpenResty config path'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL=https://' 'HTTPS public release probe URL'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_EVIDENCE_DIR=/var/lib/fsusblog/deployment/evidence$' 'durable gateway evidence path'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_SHARED_UPLOADS_VOLUME=' 'explicit shared uploads volume variable'
  require_pattern "$ENV_TEMPLATE" '^FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=' 'explicit shared DataProtection volume variable'
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
