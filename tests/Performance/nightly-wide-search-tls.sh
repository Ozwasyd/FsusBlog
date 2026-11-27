#!/usr/bin/env bash
# Serve the verified nightly payload through its production Caddy ingress.
set +x
set -euo pipefail
umask 077

if [[ $# != 5 || ${1:-} != /* || ! -x ${1:-} ]]; then
    printf 'Usage: %s DOTNET_ABS VERIFIED_RELEASE_DIR OWNED_SCRATCH_DIR EVIDENCE_DIR ORACLE_JSON\n' "$0" >&2
    exit 2
fi
dotnet=$1
release=$(cd -- "$2" && pwd -P)
owned=$(cd -- "$3" && pwd -P)
evidence=$(cd -- "$4" && pwd -P)
oracle=$(cd -- "$(dirname -- "$5")" && printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$5")")
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo"
server="$release/server/FsusBlog.V2.Server.dll"
web="$release/web"
config="$release/Caddyfile"
probe="$repo/tests/Performance/nightly-wide-search-probe.mjs"
caddy=${CADDY_BIN:?Set CADDY_BIN to the verified Caddy executable}
chrome=${FSUSBLOG_TEST_CHROME:?Set FSUSBLOG_TEST_CHROME to the verified Chromium executable}
[[ $chrome == /* && -x $chrome && -f $server && -f $web/index.html && -f $config && -s $oracle && -f $probe ]]
for executable in "$caddy" curl lsof node openssl ps python3 shasum; do
    command -v "$executable" >/dev/null
done
[[ ${PGHOST:-} == "$owned/socket" && ${PGPORT:-} =~ ^[1-9][0-9]{0,4}$ &&
    -S $PGHOST/.s.PGSQL.$PGPORT &&
    ${FSUSBLOG_DB:-} == "Host=$PGHOST;Port=$PGPORT;"* ]] || {
    printf 'The wide search witness requires the inherited nightly PostgreSQL socket.\n' >&2
    exit 2
}
# Only the upstream process receives this value. Evidence and browser children receive no DSN.
connection=$FSUSBLOG_DB
unset FSUSBLOG_DB
[[ ! -e $evidence/run.txt ]]

run=$(mktemp -d "$owned/wide-search-tls.XXXXXXXX")
server_pid=
proxy_pid=
probe_pid=
upstream_port=
public_port=
stage=starting

# shellcheck source=tests/Performance/proxy.sh
source tests/Performance/proxy.sh

stop_child() {
    local name=$1 pid=$2 status=0 forced=no requested=no rc=0
    [[ -n $pid ]] || return 0
    if own_child "$pid"; then
        requested=yes
        terminate_child "$pid" 20 || rc=$?
        if (( rc == 2 )); then forced=yes; elif (( rc != 0 )); then return 1; fi
    fi
    if own_child "$pid"; then
        printf '%s_pid=%s\n%s_exit=unconfirmed\n' "$name" "$pid" "$name" >> "$evidence/cleanup.log"
        return 1
    fi
    if wait "$pid"; then status=0; else status=$?; fi
    printf '%s_pid=%s\n%s_exit=%s\n%s_forced=%s\n' "$name" "$pid" "$name" "$status" "$name" "$forced" >> "$evidence/cleanup.log"
    [[ $forced == no && ( $status == 0 || ( $requested == yes && $status == 143 ) ) ]]
}

cleanup() {
    local status=$? cleaned=yes port
    trap - EXIT
    trap '' INT TERM
    stop_child probe "$probe_pid" || cleaned=no
    stop_child caddy "$proxy_pid" || cleaned=no
    stop_child kestrel "$server_pid" || cleaned=no
    : > "$evidence/residual-listeners.txt"
    for port in "$public_port" "$upstream_port"; do
        if [[ -n $port ]] && lsof -n -P -iTCP@127.0.0.1:"$port" -sTCP:LISTEN >> "$evidence/residual-listeners.txt" 2>/dev/null; then
            cleaned=no
        fi
    done
    if [[ $cleaned == yes && $status == 0 ]]; then find "$run" -depth -delete || cleaned=no; fi
    if [[ $cleaned != yes && $status == 0 ]]; then status=1; fi
    if [[ $status != 0 && -d $run ]]; then
        printf 'scratch_retained=%s\n' "$run" >> "$evidence/run.txt"
    fi
    printf 'stop_stage=%s\nexit=%s\ncleanup=%s\nfinished=%s\n' "$stage" "$status" "$cleaned" "$(date -u +%FT%TZ)" >> "$evidence/run.txt"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

public_port=$(choose_loopback_port)
upstream_port=$(choose_loopback_port)
while [[ $upstream_port == "$public_port" ]]; do upstream_port=$(choose_loopback_port); done
target="https://127.0.0.1:$public_port"
origin="http://127.0.0.1:$upstream_port"
{
    printf 'started=%s\npublic=%s\nupstream=%s\n' "$(date -u +%FT%TZ)" "$target" "$origin"
    "$dotnet" --version
    "$caddy" version
    "$chrome" --version
    node --version
    shasum -a 256 "$server" "$web/index.html" "$config" "$oracle" "$probe"
} > "$evidence/run.txt"

stage=upstream-start
(
    cd -- "$run"
    exec env -i PATH="$PATH" LC_ALL=C TZ=UTC TMPDIR="$run" ASPNETCORE_ENVIRONMENT=Production \
        FSUSBLOG_DB="$connection" FSUSBLOG_WEB_DIST="$web" FSUSBLOG_WIDE_SEARCH_CORPUS=true FSUSBLOG_PUBLIC_SEARCH_MODE=auto \
        FSUSBLOG_TRUST_LOOPBACK_PROXY=true FSUSBLOG_PUBLIC_ORIGIN="$target" \
        Logging__LogLevel__Microsoft=Warning Logging__LogLevel__Microsoft.Hosting.Lifetime=Information \
        "$dotnet" "$server" --urls "$origin"
) > "$evidence/server.log" 2>&1 &
server_pid=$!

stage=upstream-listener
deadline=$((SECONDS + 120))
listening=no
while (( SECONDS < deadline )); do
    own_child "$server_pid" || { printf 'Owned Kestrel exited before binding.\n' >&2; exit 1; }
    if lsof -n -P -a -p "$server_pid" -iTCP@127.0.0.1:"$upstream_port" -sTCP:LISTEN > "$evidence/upstream-listener.txt" 2>/dev/null; then
        listening=yes
        break
    fi
    sleep 0.2
done
[[ $listening == yes ]] || { printf 'Owned Kestrel did not bind within 120 seconds.\n' >&2; exit 1; }

stage=proxy-start
curl_flags=(--http1.1)
load_flags=()
status_at() {
    curl --disable --noproxy '*' --silent --show-error --max-time 2 -o /dev/null -w '%{http_code}' "$@"
}
readiness() {
    status_at --max-time 1 "${curl_flags[@]}" "$target/health/ready"
}
start_proxy "$config"
own_child "$server_pid"
printf 'wrapper_pid=%s\nkestrel_pid=%s\ncaddy_pid=%s\n' "$$" "$server_pid" "$proxy_pid" >> "$evidence/run.txt"
pin=$(openssl x509 -in "$FSUSBLOG_TLS_CERTIFICATE" -noout -pubkey |
    openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
[[ $pin =~ ^[A-Za-z0-9+/]{43}=$ ]]

stage=wide-ready
pinned=(--cacert "$proxy_ca" --pinnedpubkey "sha256//$pin")
health=$(status_at "${pinned[@]}" "$target/health/ready")
naked=$(status_at -H "Host: 127.0.0.1:$public_port" "$origin/health/ready")
printf 'public_tls_health=%s\nnaked_upstream=%s\n' "$health" "$naked" > "$evidence/ingress.txt"
[[ $health == 204 && $naked == 400 ]]
deadline=$((SECONDS + 120))
ready=
while (( SECONDS < deadline )); do
    own_child "$server_pid" && own_child "$proxy_pid" || {
        printf 'An owned TLS process exited before the wide corpus became ready.\n' >&2
        exit 1
    }
    ready=$(status_at "${pinned[@]}" "$target/api/v2/public/search-corpus/wide/v1/manifest.aeds" 2>/dev/null) || ready=
    [[ $ready != 200 ]] || break
    sleep 0.2
done
printf 'wide_manifest=%s\n' "$ready" >> "$evidence/ingress.txt"
[[ $ready == 200 ]] || { printf 'The wide corpus did not become ready within 120 seconds.\n' >&2; exit 1; }

stage=browser
env -i PATH="$PATH" LC_ALL=C TZ=UTC TMPDIR="$run" NODE_EXTRA_CA_CERTS="$proxy_ca" \
    FSUSBLOG_TEST_TLS_SPKI="$pin" FSUSBLOG_TEST_CHROME="$chrome" \
    node "$probe" "$target" "$oracle" "$evidence" > "$evidence/browser.log" 2>&1 &
probe_pid=$!
deadline=$((SECONDS + 600))
while own_child "$probe_pid"; do
    if (( SECONDS >= deadline )); then
        printf 'The wide search browser probe exceeded its 600-second wall budget.\n' >&2
        exit 1
    fi
    sleep 0.2
done
if wait "$probe_pid"; then browser_status=0; else browser_status=$?; fi
probe_pid=
if (( browser_status != 0 )); then exit "$browser_status"; fi
own_child "$server_pid" && own_child "$proxy_pid" || exit 1
stage=complete
