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
migrate=${FSUSBLOG_MIGRATE_DLL:-$repo/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}
export FSUSBLOG_TEST_CHROME=${FSUSBLOG_TEST_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
export FSUSBLOG_TEST_EVIDENCE=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/inbox-native-$(date -u +%Y%m%d-%H%M%S)}
mkdir -p "$FSUSBLOG_TEST_EVIDENCE"
evidence=$(cd -- "$FSUSBLOG_TEST_EVIDENCE" && pwd)
[[ -x "$psql" && -f "$dist/index.html" && -f "$server" && -f "$migrate" ]]

database="fsusv2_inbox_$(uuidgen | tr -d '-' | tr A-Z a-z)"
[[ $database =~ ^fsusv2_inbox_[a-f0-9]{32}$ ]]
query=("$psql" -X --no-password -v ON_ERROR_STOP=1 -h "$FSUSBLOG_TEST_PGHOST" -p "$FSUSBLOG_TEST_PGPORT" -U "$FSUSBLOG_TEST_PGUSER")
owned_db=0
server_pid=
cleanup() {
  local code=$? cleanup_ok=1
  trap - EXIT
  if [[ -n $server_pid ]]; then
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    wait "$server_pid" 2>/dev/null || true
    if kill -0 "$server_pid" 2>/dev/null; then cleanup_ok=0; fi
  fi
  if (( owned_db )); then
    printf 'DROP DATABASE %s WITH (FORCE);\n' "$database" | "${query[@]}" -d postgres >> "$evidence/db.log" 2>&1 || cleanup_ok=0
  fi
  if (( ! cleanup_ok && code == 0 )); then code=1; fi
  { printf 'ended=%s\n' "$(date -u +%FT%TZ)"; printf 'exit=%s\ncleanup=%s\n' "$code" "$cleanup_ok"; } >> "$evidence/run.txt"
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
  git -C "${FSUSBLOG_LOCAL_FSUSUI_ROOT:-$repo/../FsusUI}" rev-parse HEAD
  "$dotnet" --version
  node --version
  shasum -a 256 "$dist/index.html" "$server" "$migrate" src/Web/pnpm-lock.yaml
} > "$evidence/run.txt"
printf 'CREATE DATABASE %s TEMPLATE template0;\n' "$database" | "${query[@]}" -d postgres > "$evidence/db.log"
owned_db=1
export FSUSBLOG_DB="Host=$FSUSBLOG_TEST_PGHOST;Port=$FSUSBLOG_TEST_PGPORT;Username=$FSUSBLOG_TEST_PGUSER;Database=$database;SSL Mode=Disable"
export FSUSBLOG_WEB_DIST=$dist
export FSUSBLOG_PRIVATE_INBOX_WRITES=true
"$dotnet" "$migrate" plan > "$evidence/schema-plan.json"
"$dotnet" "$migrate" apply "$evidence/schema-plan.json" > "$evidence/schema.log"
FSUSBLOG_INBOX_DESKTOP_TICKET=$("$dotnet" "$migrate" operator inbox-desktop --reader)
FSUSBLOG_INBOX_MOBILE_TICKET=$("$dotnet" "$migrate" operator inbox-mobile --reader)
export FSUSBLOG_INBOX_DESKTOP_TICKET FSUSBLOG_INBOX_MOBILE_TICKET

FSUSBLOG_INBOX_DESKTOP_ID=$("${query[@]}" -d "$database" -qAtc "SELECT id FROM public.blog_user WHERE name='inbox-desktop';")
FSUSBLOG_INBOX_MOBILE_ID=$("${query[@]}" -d "$database" -qAtc "SELECT id FROM public.blog_user WHERE name='inbox-mobile';")
export FSUSBLOG_INBOX_DESKTOP_ID FSUSBLOG_INBOX_MOBILE_ID
for recipient in "$FSUSBLOG_INBOX_DESKTOP_ID" "$FSUSBLOG_INBOX_MOBILE_ID"; do
  printf '%s' '{"subject":"Integration fixture notice","body":"Integration fixture private body"}' |
    "$dotnet" "$migrate" notify "$recipient" initial-notice >> "$evidence/schema.log"
done
printf '%s' '{"subject":"Integration fixture notice","body":"Integration fixture private body"}' |
  "$dotnet" "$migrate" notify "$FSUSBLOG_INBOX_DESKTOP_ID" initial-notice > "$evidence/replayed-notice.json"
rg -q '"replayed": true' "$evidence/replayed-notice.json"
if printf '%s' '{"subject":"Integration fixture notice","body":"Different retry body"}' |
    "$dotnet" "$migrate" notify "$FSUSBLOG_INBOX_DESKTOP_ID" initial-notice > "$evidence/notice-conflict.log" 2>&1; then
  printf 'Conflicting notice retry was accepted.\n' >&2
  exit 1
fi
rg -q 'different request' "$evidence/notice-conflict.log"
"$dotnet" "$migrate" verify >> "$evidence/schema.log"

"$dotnet" "$server" --urls http://127.0.0.1:0 > "$evidence/server.log" 2>&1 &
server_pid=$!
url=
for (( attempt=0; attempt<100; attempt++ )); do
  url=$(sed -nE 's/^[[:space:]]*Now listening on: (http:\/\/127\.0\.0\.1:[0-9]+)$/\1/p' "$evidence/server.log")
  if [[ -n $url ]] && curl --silent --fail "$url/health/ready" >/dev/null; then break; fi
  kill -0 "$server_pid"
  sleep 0.2
done
[[ -n $url ]] && curl --silent --fail "$url/health/ready" >/dev/null
export FSUSBLOG_TEST_URL=$url
export FSUSBLOG_INBOX_MIGRATE_DLL=$migrate
export FSUSBLOG_INBOX_DOTNET=$dotnet
node tests/EndToEnd/inbox-flow.mjs

[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_conversation WHERE subject='Integration fixture notice' AND read_through=last_message_id;") == 2 ]]
[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_conversation WHERE subject IN ('Native support desktop', 'Native support mobile') AND NOT is_system;") == 2 ]]
[[ $("${query[@]}" -d "$database" -qAtc "SELECT count(*) FROM public.inbox_message m JOIN public.inbox_conversation c ON c.id=m.conversation_id WHERE c.subject IN ('Native support desktop', 'Native support mobile') AND m.sender=0 AND NOT m.is_internal AND m.body IN ('Native proof sent this ticket.', 'Native proof sent this reply.');") == 4 ]]
