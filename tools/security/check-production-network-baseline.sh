#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/ops/docker/docker-compose.production.yml"
GATEWAY_FILE="$ROOT_DIR/ops/gateway/production-openresty.conf"
GATEWAY_UPSTREAM_EXAMPLE="$ROOT_DIR/ops/gateway/active-upstream.conf.example"
ENV_TEMPLATE="$ROOT_DIR/config/examples/.env.production.example"

failures=()

RequireFile() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        failures+=("missing file: ${file#"$ROOT_DIR"/}")
    fi
}

RequirePattern() {
    local file="$1"
    local pattern="$2"
    local label="$3"
    if ! grep -Eq "$pattern" "$file"; then
        failures+=("${file#"$ROOT_DIR"/}: missing $label")
    fi
}

RejectPattern() {
    local file="$1"
    local pattern="$2"
    local label="$3"
    if grep -Eq "$pattern" "$file"; then
        failures+=("${file#"$ROOT_DIR"/}: forbidden $label")
    fi
}

RequireLocationPattern() {
    local file="$1"
    local location="$2"
    local pattern="$3"
    local label="$4"
    local identityPattern="${5:-$pattern}"
    local block
    if ! block=$(awk -v marker="$location" '
        BEGIN { split(marker, parts, " "); privatePrefix = parts[3] }
        {
            line = $0
            sub(/#.*/, "", line)
            trimmed = line
            sub(/^[[:space:]]*/, "", trimmed)
            sub(/[[:space:]]*$/, "", trimmed)
            if (trimmed ~ /^location[[:space:]]/ && index(trimmed, privatePrefix) && trimmed != marker) exit 2
        }
        trimmed == marker {
            found++
            if (inside) exit 2
            inside = 1
        }
        inside {
            if (depth == 1 && line ~ /\{/) exit 2
            if (depth == 1 && line !~ /[{}]/) print line
            depth += gsub(/\{/, "{", line)
            depth -= gsub(/\}/, "}", line)
            if (depth < 0) exit 2
            if (depth == 0) inside = 0
        }
        END { if (found != 1 || inside || depth != 0) exit 2 }
    ' "$file") || [[ "$(grep -Ec "$pattern" <<<"$block")" -ne 1 ]] || [[ "$(grep -Ec "$identityPattern" <<<"$block")" -ne 1 ]]; then
        failures+=("${file#"$ROOT_DIR"/}: missing $label in unique $location location")
    fi
}

RequireSinglePrivateAlias() {
    local file="$1"
    if ! awk '
        BEGIN { privateRoot = "/var/lib/fsusblog/storage/shared/assets/private" }
        {
            line = $0
            sub(/#.*/, "", line)
            count = split(line, parts, /[;{}]/)
            for (i = 1; i <= count; i++) {
                directive = parts[i]
                sub(/^[[:space:]]*/, "", directive)
                sub(/[[:space:]]*$/, "", directive)
                if (directive ~ /^(alias|root)[[:space:]]/) {
                    if (split(directive, fields, /[[:space:]]+/) != 2) invalid = 1
                    path = fields[2]
                    gsub(/"/, "", path)
                    if (path !~ /^\// || path ~ /[$\\]|\/\.\.?(\/|$)/) invalid = 1
                    gsub(/\/+/, "/", path)
                    gsub(/\/\.\//, "/", path)
                    sub(/\/$/, "", path)
                    if (path == "" || path == privateRoot || index(privateRoot, path "/") == 1 || index(path, privateRoot "/") == 1) {
                        found++
                        if (directive != "alias /var/lib/fsusblog/storage/shared/assets/private/") invalid = 1
                    }
                }
            }
        }
        END { if (found != 1 || invalid) exit 2 }
    ' "$file"; then
        failures+=("${file#"$ROOT_DIR"/}: missing sole declared private physical alias")
    fi
}

RequireComposePattern() {
    local file="$1"
    local selector="$2"
    local pattern="$3"
    local label="$4"
    local identityPattern="${5:-$pattern}"
    local block
    if ! block=$(awk -v selector="$selector" '
        BEGIN { levels = split(selector, keys, "/") }
        {
            line = $0
            sub(/#.*/, "", line)
            if (line ~ /^[[:space:]]*$/) next
            match(line, /[^ ]/)
            indent = RSTART - 1
            trimmed = substr(line, indent + 1)
            sub(/[[:space:]]*$/, "", trimmed)
            if (indent == 0) mountServices = (trimmed == "services:")
            if (indent <= 4) mountServer = (mountServices && indent == 4 && trimmed == "fsusblog.server:")
            if (indent <= 8) mountVolumes = (mountServer && indent == 8 && trimmed == "volumes:")
            if (line ~ /\t/ || (indent % 4 != 0 && !(mountVolumes && indent >= 14 && indent % 4 == 2))) exit 2
            level = int(indent / 4) + 1
            for (i = level; i <= levels; i++) active[i] = 0
            parent = 1
            for (i = 1; i < level && i <= levels; i++) parent = parent && active[i]
            if (level <= levels && parent && trimmed == keys[level] ":") {
                active[level] = 1
                found[level]++
            }
            if (level > levels && parent && (level == levels + 1 || selector == "services/fsusblog.server/volumes")) print line
        }
        END { for (i = 1; i <= levels; i++) if (found[i] != 1) exit 2 }
    ' "$file") || [[ "$(grep -Ec "$pattern" <<<"$block")" -ne 1 ]] || [[ "$(grep -Ec "$identityPattern" <<<"$block")" -ne 1 ]]; then
        failures+=("${file#"$ROOT_DIR"/}: missing $label in unique $selector owner")
    fi
}

RequireUnshadowedPrivateStorage() {
    local file="$1"
    if ! awk '
        function checkTarget(path, declaredStorage, count, components, i, depth, normalized) {
            gsub(/["\047]/, "", path)
            if (path !~ /^\// || path ~ /[$\\]/) { invalid = 1; return }
            count = split(path, components, "/")
            depth = 0
            for (i = 1; i <= count; i++) {
                if (components[i] == "" || components[i] == ".") continue
                if (components[i] == "..") { if (depth > 0) depth--; continue }
                normalized[++depth] = components[i]
            }
            path = ""
            for (i = 1; i <= depth; i++) path = path "/" normalized[i]
            if (path == "") path = "/"
            if (!declaredStorage && (path == "/" || path == privateRoot || index(privateRoot, path "/") == 1 || index(path, privateRoot "/") == 1)) invalid = 1
        }
        function checkLongField(field, key) {
            if (!match(field, /^([[:alnum:]_]+|"[[:alnum:]_]+"|\047[[:alnum:]_]+\047)[[:space:]]*:/)) { invalid = 1; return }
            key = substr(field, 1, RLENGTH)
            gsub(/["\047[:space:]:]/, "", key)
            field = substr(field, RLENGTH + 1)
            sub(/^[[:space:]]*/, "", field)
            if (key == "target") checkTarget(field, 0)
            else if (key !~ /^(type|source|read_only|consistency|bind|volume|tmpfs|image|propagation|create_host_path|selinux|nocopy|subpath|size|mode)$/) invalid = 1
        }
        BEGIN { privateRoot = "/app/storage/shared/assets/private" }
        {
            line = $0
            sub(/#.*/, "", line)
            if (line ~ /^[[:space:]]*$/) next
            match(line, /[^ ]/)
            indent = RSTART - 1
            trimmed = substr(line, indent + 1)
            sub(/[[:space:]]*$/, "", trimmed)
            if (indent == 0) services = (trimmed == "services:")
            if (indent <= 4) server = (services && indent == 4 && trimmed == "fsusblog.server:")
            if (indent <= 8) volumes = (server && indent == 8 && trimmed == "volumes:")
            if (!volumes || indent <= 8) next
            if (trimmed ~ /^-[[:space:]]/) {
                sub(/^-[[:space:]]+/, "", trimmed)
                declaredStorage = (trimmed == "fsus-storage:/app/storage")
                gsub(/["\047]/, "", trimmed)
                if (match(trimmed, /:\/[^:]*/)) checkTarget(substr(trimmed, RSTART + 1, RLENGTH - 1), declaredStorage)
                else if (trimmed ~ /^\//) checkTarget(trimmed, 0)
                else checkLongField(trimmed)
            } else checkLongField(trimmed)
        }
        END { if (invalid) exit 2 }
    ' "$file"; then
        failures+=("${file#"$ROOT_DIR"/}: forbidden private storage mount shadow")
    fi
}

RequireFile "$COMPOSE_FILE"
RequireFile "$GATEWAY_FILE"
RequireFile "$GATEWAY_UPSTREAM_EXAMPLE"
RequireFile "$ENV_TEMPLATE"

if [[ -f "$COMPOSE_FILE" ]]; then
    RequirePattern "$COMPOSE_FILE" '127\.0\.0\.1:\$\{FSUSBLOG_SLOT_PORT:\?[^}]+\}:8080' 'slot-parameterized loopback-only Kestrel port binding'
    RequirePattern "$COMPOSE_FILE" 'container_name:[[:space:]]+\$\{FSUSBLOG_CONTAINER_NAME:\?' 'slot-specific container identity'
    RequireComposePattern "$COMPOSE_FILE" 'volumes/fsus-storage' '^[[:space:]]+name:[[:space:]]+\$\{FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:\?[^}]+\}$' 'explicit shared public-assets volume' '^[[:space:]]+name:'
    RequireComposePattern "$COMPOSE_FILE" 'services/fsusblog.server/environment' '^[[:space:]]+-[[:space:]]+FSUSBLOG_SHARED_STORAGE_ROOT=/app/storage/shared$' 'shared storage root outside WebRoot' '^[[:space:]]+-[[:space:]]+[^[:alnum:]]*FSUSBLOG_SHARED_STORAGE_ROOT([^[:alnum:]_]|$)'
    RequireComposePattern "$COMPOSE_FILE" 'services/fsusblog.server/environment' '^[[:space:]]+-[[:space:]]+FSUSBLOG_INSTANCE_STORAGE_ROOT=/app/storage/instances$' 'instance storage root outside WebRoot' '^[[:space:]]+-[[:space:]]+[^[:alnum:]]*FSUSBLOG_INSTANCE_STORAGE_ROOT([^[:alnum:]_]|$)'
    RequireComposePattern "$COMPOSE_FILE" 'services/fsusblog.server/volumes' '^            -[[:space:]]+fsus-storage:/app/storage[[:space:]]*$' 'single shared app storage mount' '(:/app/storage/*([^[:alnum:]_/.]|$)|target:[[:space:]]+[^[:alnum:]/]*/app/storage/*([^[:alnum:]_/.]|$))'
    RequireUnshadowedPrivateStorage "$COMPOSE_FILE"
    RequirePattern "$COMPOSE_FILE" '^[[:space:]]+fsus-storage:[[:space:]]*$' 'host-backed shared storage volume'
    RequireComposePattern "$COMPOSE_FILE" 'volumes/fsus-storage' '^[[:space:]]+driver:[[:space:]]+local$' 'host-backed shared storage volume driver' '^[[:space:]]+driver:'
    RequireComposePattern "$COMPOSE_FILE" 'volumes/fsus-storage/driver_opts' '^[[:space:]]+type:[[:space:]]+none$' 'host-backed shared storage volume type' '^[[:space:]]+type:'
    RequireComposePattern "$COMPOSE_FILE" 'volumes/fsus-storage/driver_opts' '^[[:space:]]+o:[[:space:]]+bind$' 'host-backed shared storage volume bind option' '^[[:space:]]+o:'
    RequireComposePattern "$COMPOSE_FILE" 'volumes/fsus-storage/driver_opts' '^[[:space:]]+device:[[:space:]]+/var/lib/fsusblog/storage[[:space:]]*$' 'shared storage host root' '^[[:space:]]+device:'
    RequirePattern "$COMPOSE_FILE" 'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:\?' 'explicit shared DataProtection volume'
    RejectPattern "$COMPOSE_FILE" '/app/storage/shared/assets/private' 'direct private asset directory mount'
    RejectPattern "$COMPOSE_FILE" '/app/wwwroot/uploads' 'legacy WebRoot uploads mount'
    RejectPattern "$COMPOSE_FILE" 'FSUSBLOG_SHARED_UPLOADS_VOLUME' 'retired shared uploads volume variable'
    RejectPattern "$COMPOSE_FILE" '127\.0\.0\.1:8080:8080' 'retired single-slot Kestrel binding'
    RejectPattern "$COMPOSE_FILE" '(^|["[:space:]])8080:8080(["[:space:]]|$)' 'public Kestrel 8080 binding'
    RejectPattern "$COMPOSE_FILE" '(^|["[:space:]])6379:6379(["[:space:]]|$)' 'public Redis port binding'
    RejectPattern "$COMPOSE_FILE" '(^|["[:space:]])5432:5432(["[:space:]]|$)' 'public PostgreSQL port binding'
    RequirePattern "$COMPOSE_FILE" 'AllowedHosts=\$\{APP_ALLOWED_HOSTS\}' 'AllowedHosts production environment binding'
    RequirePattern "$COMPOSE_FILE" 'ReverseProxy__KnownProxies=' 'reverse proxy known proxies binding'
    RequirePattern "$COMPOSE_FILE" 'DOTNET_DbgEnableMiniDump=0' 'managed dump disablement'
    RequirePattern "$COMPOSE_FILE" 'COMPlus_DbgEnableMiniDump=0' 'legacy managed dump disablement'
    RequirePattern "$COMPOSE_FILE" 'DOTNET_EnableDiagnostics=0' 'production diagnostic port disablement'
    RequirePattern "$COMPOSE_FILE" 'cap_drop:' 'container capability drop policy'
    RequirePattern "$COMPOSE_FILE" '^[[:space:]]+-[[:space:]]+ALL[[:space:]]*$' 'all Linux capabilities dropped'
    RequirePattern "$COMPOSE_FILE" 'no-new-privileges:true' 'no-new-privileges policy'
    RequirePattern "$COMPOSE_FILE" 'ulimits:' 'container ulimit policy'
    RequirePattern "$COMPOSE_FILE" '^[[:space:]]+core:[[:space:]]*$' 'core dump ulimit'
    RequirePattern "$COMPOSE_FILE" '^[[:space:]]+soft:[[:space:]]+0[[:space:]]*$' 'core dump soft limit zero'
    RequirePattern "$COMPOSE_FILE" '^[[:space:]]+hard:[[:space:]]+0[[:space:]]*$' 'core dump hard limit zero'
    RejectPattern "$COMPOSE_FILE" '(DOTNET_DbgEnableMiniDump|COMPlus_DbgEnableMiniDump|DOTNET_EnableDiagnostics)=[1-9]' 'enabled production dump or diagnostic switch'
    RejectPattern "$COMPOSE_FILE" '^[[:space:]]+(soft|hard):[[:space:]]+(-1|unlimited)[[:space:]]*$' 'unlimited core dump policy'
fi

if [[ -f "$GATEWAY_FILE" ]]; then
    RequirePattern "$GATEWAY_FILE" 'include[[:space:]]+/etc/openresty/fsusblog/active-upstream\.conf;' 'controlled dynamic active upstream include'
    RejectPattern "$GATEWAY_FILE" 'server[[:space:]]+127\.0\.0\.1:8080;' 'retired fixed application upstream'
    RequirePattern "$GATEWAY_FILE" 'server_name[[:space:]]+_;' 'default unknown Host server'
    RequirePattern "$GATEWAY_FILE" 'return[[:space:]]+444;' 'unknown Host rejection'
    RequirePattern "$GATEWAY_FILE" 'limit_req_zone' 'request rate limit zones'
    RequirePattern "$GATEWAY_FILE" 'limit_conn_zone' 'connection limit zone'
    RequirePattern "$GATEWAY_FILE" 'location[[:space:]]+~[[:space:]]+/\\\.\(\?!well-known\)' 'hidden file deny rule'
    RequirePattern "$GATEWAY_FILE" '\\\.\(bak\|old\|orig\|save\|sql\|tar\|gz\|zip\|7z\|rar\)' 'backup/archive deny rule'
    RequirePattern "$GATEWAY_FILE" 'client_max_body_size[[:space:]]+5m;' 'explicit upload limit'
    RequirePattern "$GATEWAY_FILE" "proxy_set_header[[:space:]]+Upgrade[[:space:]]+\\\$http_upgrade;" 'WebSocket upgrade forwarding'
    RequirePattern "$GATEWAY_FILE" 'proxy_buffering[[:space:]]+off;' 'WebSocket buffering disabled'
    RequirePattern "$GATEWAY_FILE" 'Strict-Transport-Security' 'HSTS response header'
    RequirePattern "$GATEWAY_FILE" 'user[[:space:]]+fsusblog;' 'private asset owner-matched worker identity'
    RequirePattern "$GATEWAY_FILE" 'location[[:space:]]+\^~[[:space:]]+/assets/private/' 'private ticket proxy lane'
    RequirePattern "$GATEWAY_FILE" 'location[[:space:]]+\^~[[:space:]]+/_fsus/private-assets/' 'private internal sendfile lane'
    RequirePattern "$GATEWAY_FILE" 'alias[[:space:]]+/var/lib/fsusblog/storage/shared/assets/private/;' 'private host-backed alias'
    RequirePattern "$GATEWAY_FILE" 'internal;' 'private alias internal guard'
    RequireLocationPattern "$GATEWAY_FILE" 'location ^~ /assets/private/ {' '^[[:space:]]*access_log[[:space:]]+off;[[:space:]]*$' 'ticket path access log disabled' '^[[:space:]]*access_log[[:space:]]'
    RequireLocationPattern "$GATEWAY_FILE" 'location ^~ /_fsus/private-assets/ {' '^[[:space:]]*internal;[[:space:]]*$' 'private alias internal guard' '^[[:space:]]*internal[[:space:];]'
    RequireLocationPattern "$GATEWAY_FILE" 'location ^~ /_fsus/private-assets/ {' '^[[:space:]]*alias[[:space:]]+/var/lib/fsusblog/storage/shared/assets/private/;[[:space:]]*$' 'private host-backed alias' '^[[:space:]]*(alias|root)[[:space:]]'
    RequireSinglePrivateAlias "$GATEWAY_FILE"
    RejectPattern "$GATEWAY_FILE" 'PrivateAssetRoot' 'application private root exposure in gateway'
fi

if [[ -f "$GATEWAY_UPSTREAM_EXAMPLE" ]]; then
    RequirePattern "$GATEWAY_UPSTREAM_EXAMPLE" '^server[[:space:]]+127\.0\.0\.1:808[12];$' 'single controlled blue/green loopback server'
    RejectPattern "$GATEWAY_UPSTREAM_EXAMPLE" 'server[[:space:]]+(0\.0\.0\.0|::|10\.|172\.|192\.168\.|[A-Za-z])' 'non-loopback or hostname upstream'
    if [[ "$(wc -l <"$GATEWAY_UPSTREAM_EXAMPLE")" -ne 1 ]]; then
        failures+=("ops/gateway/active-upstream.conf.example: must contain exactly one generated server line")
    fi
fi

if [[ -f "$ENV_TEMPLATE" ]]; then
    RequirePattern "$ENV_TEMPLATE" '^APP_ALLOWED_HOSTS=' 'AllowedHosts template variable'
    RequirePattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_PROXIES=' 'reverse proxy known proxies template variable'
    RequirePattern "$ENV_TEMPLATE" '^REVERSE_PROXY_KNOWN_NETWORKS=' 'reverse proxy known networks template variable'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_BLUE_PORT=8081$' 'blue loopback port'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_GREEN_PORT=8082$' 'green loopback port'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_SLOT_STATE_FILE=/var/lib/fsusblog/deployment/slots\.json$' 'durable slot state path'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_DEPLOYMENT_LOCK_FILE=/var/lock/fsusblog-deployment\.lock$' 'shared deployment lock path'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM=/etc/openresty/fsusblog/active-upstream\.conf$' 'controlled active upstream path'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_CONFIG_FILE=/etc/openresty/nginx\.conf$' 'complete OpenResty config path'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL=https://' 'HTTPS public release probe URL'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_GATEWAY_EVIDENCE_DIR=/var/lib/fsusblog/deployment/evidence$' 'durable gateway evidence path'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME=' 'explicit shared public-assets volume variable'
    RequirePattern "$ENV_TEMPLATE" '^FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=' 'explicit shared DataProtection volume variable'
fi

if [[ "${FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST:-0}" != "1" ]]; then
    "$ROOT_DIR/tools/security/check-production-exposure-prereqs.sh"
    "$ROOT_DIR/tools/security/test-production-exposure-tools.sh"
    "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/production-network-baseline.test.mjs"
fi

if ((${#failures[@]} > 0)); then
    printf '[production-network-baseline] failed\n' >&2
    for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$failure" >&2
    done
    exit 1
fi

printf '[production-network-baseline] ok\n'
