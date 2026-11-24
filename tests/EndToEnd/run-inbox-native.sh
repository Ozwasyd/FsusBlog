#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
: "${FSUSBLOG_TEST_PGHOST:?Set the path to an isolated PostgreSQL Unix socket}"
: "${FSUSBLOG_TEST_PGPORT:?Set its port}"
: "${FSUSBLOG_TEST_PGUSER:?Set a test role with CREATE DATABASE permission}"
psql=${PG_TOOLS_DIR:-/opt/homebrew/opt/libpq/bin}/psql
dotnet=${FSUS_DOTNET:-dotnet}
dist=${FSUSBLOG_WEB_DIST:-$repo/src/Web/dist}
server=${FSUSBLOG_SERVER_DLL:-$repo/src/Server/bin/Release/net10.0/FsusBlog.V2.Server.dll}
migrate=${FSUSBLOG_CLI_DLL:-$repo/src/Cli/bin/Release/net10.0/FsusBlog.V2.Cli.dll}
export FSUSBLOG_TEST_CHROME=${FSUSBLOG_TEST_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
export FSUSBLOG_TEST_EVIDENCE=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/inbox-native-$(date -u +%Y%m%d-%H%M%S)}
mkdir -p "$FSUSBLOG_TEST_EVIDENCE"
evidence=$(cd -- "$FSUSBLOG_TEST_EVIDENCE" && pwd)
[[ -x "$psql" && -f "$dist/index.html" && -f "$server" && -f "$migrate" ]]

database="fsusv2_inbox_$(uuidgen | tr -d '-' | LC_ALL=C tr '[:upper:]' '[:lower:]')"
[[ $database =~ ^fsusv2_inbox_[a-f0-9]{32}$ ]]
query=("$psql" -X --no-password -v ON_ERROR_STOP=1 -h "$FSUSBLOG_TEST_PGHOST" -p "$FSUSBLOG_TEST_PGPORT" -U "$FSUSBLOG_TEST_PGUSER")
owned_db=0
server_pid=
proxy_pid=
run=
target=
origin=
own_child() { [[ -n $1 && "$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')" == "$$" ]]; }
cleanup() {
  local code=$? cleanup_ok=1 pid address
  trap - EXIT
  for pid in "$proxy_pid" "$server_pid"; do
    if [[ -n $pid ]]; then
      if own_child "$pid"; then kill "$pid"; fi
      wait "$pid" 2>/dev/null || true
      if own_child "$pid"; then cleanup_ok=0; fi
    fi
  done
  if [[ -n $run ]]; then
    rm -rf -- "$run" || cleanup_ok=0
    for address in "$origin" "$target"; do
      if [[ -n $address ]] && lsof -n -P -iTCP@"127.0.0.1:${address##*:}" -sTCP:LISTEN > /dev/null 2>&1; then cleanup_ok=0; fi
    done
  fi
  if (( owned_db )); then
    printf 'DROP DATABASE %s WITH (FORCE);\n' "$database" | "${query[@]}" -d postgres >> "$evidence/db.log" 2>&1 || cleanup_ok=0
  fi
  if (( ! cleanup_ok && code == 0 )); then code=1; fi
  printf 'ended=%s\nexit=%s\ncleanup=%s\n' "$(date -u +%FT%TZ)" "$code" "$cleanup_ok" >> "$evidence/run.txt"
  printf 'Evidence: %s\n' "$evidence"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{
  printf 'started=%s\n' "$(date -u +%FT%TZ)"
  git rev-parse HEAD
  git status --porcelain
  node -p "const p = require('$repo/src/Web/node_modules/@ozwasyd/element-plus/package.json'); p.name + '@' + p.version"
  "$dotnet" --version
  node --version
  shasum -a 256 "$dist/index.html" "$server" "$migrate" src/Web/pnpm-lock.yaml
} > "$evidence/run.txt"
printf 'CREATE DATABASE %s TEMPLATE template0;\n' "$database" | "${query[@]}" -d postgres > "$evidence/db.log"
owned_db=1
export FSUSBLOG_DB="Host=$FSUSBLOG_TEST_PGHOST;Port=$FSUSBLOG_TEST_PGPORT;Username=$FSUSBLOG_TEST_PGUSER;Database=$database;SSL Mode=Disable"
export FSUSBLOG_WEB_DIST=$dist FSUSBLOG_PRIVATE_INBOX_WRITES=true
cli() { "$dotnet" "$migrate" "$@"; }
cli plan > "$evidence/schema-plan.json"
cli apply "$evidence/schema-plan.json" > "$evidence/schema.log"
export FSUSBLOG_INBOX_DESKTOP_TICKET="$(cli operator inbox-desktop --reader)" FSUSBLOG_INBOX_MOBILE_TICKET="$(cli operator inbox-mobile --reader)"
export FSUSBLOG_INBOX_DESKTOP_ID="$("${query[@]}" -d "$database" -qAtc "SELECT id FROM public.blog_user WHERE name='inbox-desktop';")"
export FSUSBLOG_INBOX_MOBILE_ID="$("${query[@]}" -d "$database" -qAtc "SELECT id FROM public.blog_user WHERE name='inbox-mobile';")"
initial_notice='{"subject":"Integration fixture notice","body":"Integration fixture private body"}'
for recipient in "$FSUSBLOG_INBOX_DESKTOP_ID" "$FSUSBLOG_INBOX_MOBILE_ID"; do
  printf '%s' "$initial_notice" | cli notify "$recipient" initial-notice >> "$evidence/schema.log"
done
printf '%s' "$initial_notice" | cli notify "$FSUSBLOG_INBOX_DESKTOP_ID" initial-notice > "$evidence/replayed-notice.json"
rg -q '"replayed": true' "$evidence/replayed-notice.json"
if printf '%s' '{"subject":"Integration fixture notice","body":"Different retry body"}' |
    cli notify "$FSUSBLOG_INBOX_DESKTOP_ID" initial-notice > "$evidence/notice-conflict.log" 2>&1; then
  printf 'Conflicting notice retry was accepted.\n' >&2
  exit 1
fi
rg -q 'different request' "$evidence/notice-conflict.log"
cli verify >> "$evidence/schema.log"

# shellcheck source=tests/Performance/proxy.sh
source tests/Performance/proxy.sh
port=$(choose_loopback_port)
origin="http://127.0.0.1:$port"
target="http://localhost:$port"
if [[ ${FSUSBLOG_TEST_INBOX_TLS:-0} == 1 ]]; then
  caddy=${CADDY_BIN:-caddy}
  for executable in "$caddy" openssl lsof; do command -v "$executable" >/dev/null; done
  run=$(mktemp -d /tmp/fsusv2-inbox-tls.XXXXXXXX)
  curl_flags=(--http1.1)
  load_flags=()
  target="https://localhost:$(choose_loopback_port)"
  export FSUSBLOG_TRUST_LOOPBACK_PROXY=true FSUSBLOG_PUBLIC_ORIGIN="$target"
  "$caddy" version >> "$evidence/run.txt"
fi
export FSUSBLOG_PASSKEY_ORIGIN="$target" FSUSBLOG_PASSKEY_RP_ID=localhost
"$dotnet" "$server" --urls "$origin" > "$evidence/server.log" 2>&1 &
server_pid=$!
if [[ -n $run ]]; then
  start_proxy "$repo/deploy/Caddyfile"
  export NODE_EXTRA_CA_CERTS="$proxy_ca"
  FSUSBLOG_TEST_TLS_SPKI=$(openssl x509 -in "$FSUSBLOG_TLS_CERTIFICATE" -noout -pubkey |
    openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
  [[ -n $FSUSBLOG_TEST_TLS_SPKI ]]
  export FSUSBLOG_TEST_TLS_SPKI
  shasum -a 256 deploy/Caddyfile >> "$evidence/run.txt"
else
  curl_flags=(--http1.1)
  for (( attempt=0; attempt<100; attempt++ )); do
    if [[ $(readiness 2>/dev/null) == 204 ]]; then break; fi
    own_child "$server_pid"
    sleep 0.2
  done
  [[ $(readiness) == 204 ]]
fi
export FSUSBLOG_TEST_URL=$target
export FSUSBLOG_INBOX_CLI_DLL=$migrate
export FSUSBLOG_INBOX_DOTNET=$dotnet
node tests/EndToEnd/inbox-flow.mjs

[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_conversation WHERE subject='Integration fixture notice' AND read_through=last_message_id;") == 2 ]]
[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_conversation WHERE subject IN ('Native support desktop', 'Native support mobile') AND NOT is_system;") == 2 ]]
[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_message m JOIN public.inbox_conversation c ON c.id=m.conversation_id WHERE c.subject IN ('Native support desktop', 'Native support mobile') AND m.sender=0 AND NOT m.is_internal AND m.body IN ('Native proof sent this ticket.', 'Native proof sent this reply.');") == 4 ]]
