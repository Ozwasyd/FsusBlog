#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
export PG_TOOLS_DIR=${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}
export FSUSBLOG_TEST_CHROME=${FSUSBLOG_TEST_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
export FSUSBLOG_TEST_REQUIRE_NATIVE=${FSUSBLOG_TEST_REQUIRE_NATIVE:-1}
for command in initdb pg_ctl psql; do
  [[ -x "$PG_TOOLS_DIR/$command" ]] || { printf 'Missing %s\n' "$PG_TOOLS_DIR/$command" >&2; exit 1; }
done

scratch=$(mktemp -d /tmp/fsusv2-e2e.XXXXXX)
evidence=${FSUSBLOG_TEST_EVIDENCE:-$repo/artifacts/native-e2e-$(basename "$scratch")}
mkdir -p "$evidence" "$scratch/socket"
evidence=$(cd -- "$evidence" && pwd)
export FSUSBLOG_TEST_EVIDENCE="$evidence"
server_pid=
pg_started=0
db() { "$PG_TOOLS_DIR/psql" -X -v ON_ERROR_STOP=1 -h "$scratch/socket" -p 54930 -U fsusqa -d postgres "$@"; }
bootstrap_admin() { export "$1=$("${migrate[@]}" admin-identity bootstrap "$2")"; }
make_media_dir() { mkdir -m 700 "$scratch/$2"; export "$1=$(cd "$scratch/$2" && pwd -P)"; }
cleanup() {
  local code=$? cleanup_ok=1
  trap - EXIT
  if [[ -n "$server_pid" ]]; then
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    wait "$server_pid" 2>/dev/null || true
    if kill -0 "$server_pid" 2>/dev/null; then cleanup_ok=0; fi
  fi
  if (( pg_started )); then
    if ! "$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" -m fast -w stop >> "$evidence/postgres.log" 2>&1; then cleanup_ok=0; fi
    if "$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" status >/dev/null 2>&1; then cleanup_ok=0; fi
  fi
  if (( cleanup_ok )); then rm -rf -- "$scratch" || cleanup_ok=0; fi
  if (( ! cleanup_ok && code == 0 )); then code=1; fi
  printf 'ended=%s\nexit=%s\ncleanup=%s\n' "$(date -u +%FT%TZ)" "$code" "$cleanup_ok" >> "$evidence/run.txt"
  printf 'Evidence: %s\n' "$evidence"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

server_source=${FSUSBLOG_NATIVE_SERVER_BUILD:-$repo/src/Server/bin/Release/net10.0}
migrate_source=${FSUSBLOG_NATIVE_CLI_BUILD:-$repo/src/Cli/bin/Release/net10.0}
web_source=${FSUSBLOG_WEB_DIST:-$repo/src/Web/dist}
mkdir -p "$scratch/server" "$scratch/migrate" "$scratch/web"
cp -R "$server_source/." "$scratch/server"
cp -R "$migrate_source/." "$scratch/migrate"
cp -R "$web_source/." "$scratch/web"
export FSUSBLOG_WEB_DIST="$scratch/web"

{
  printf 'started=%s\n' "$(date -u +%FT%TZ)"
  git rev-parse HEAD
  git status --porcelain
  dotnet --version
  node --version
  "$PG_TOOLS_DIR/postgres" --version
  shasum -a 256 src/Web/pnpm-lock.yaml src/Server/packages.lock.json
  (cd "$scratch" && shasum -a 256 web/index.html server/FsusBlog.V2.Server.dll migrate/FsusBlog.V2.Cli.dll)
} > "$evidence/run.txt"

"$PG_TOOLS_DIR/initdb" -D "$scratch/data" -U fsusqa --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/initdb.log"
pg_started=1
"$PG_TOOLS_DIR/pg_ctl" -D "$scratch/data" -l "$evidence/postgres.log" \
  -o "-c listen_addresses='' -k $scratch/socket -p 54930 -c unix_socket_permissions=0700" -w start
export FSUSBLOG_DB="Host=$scratch/socket;Port=54930;Username=fsusqa;Database=postgres;SSL Mode=Disable"

migrate=(dotnet "$scratch/migrate/FsusBlog.V2.Cli.dll")
"${migrate[@]}" plan > "$evidence/schema-plan.json"
"${migrate[@]}" apply "$evidence/schema-plan.json" > "$evidence/schema.log"
if [[ ${FSUSBLOG_TEST_MEDIA_WEBP:-0} == 1 ]]; then
  "${migrate[@]}" media-webp schema >> "$evidence/schema.log"
  "${migrate[@]}" media-webp schema >> "$evidence/schema.log"
fi
"${migrate[@]}" verify >> "$evidence/schema.log"
export FSUSBLOG_TEST_TICKET="$("${migrate[@]}" operator browser-author)"
flow=${FSUSBLOG_TEST_FLOW:-blog}
media_flow=0
case "$flow" in
  private-media|article-media|public-article-media) media_flow=1 ;;
esac
case "$flow" in
  blog|canvas-keyboard|canvas-scale|editor-readiness|workspace-recovery|workspace-split|workspace-locale|article-library|property-history|property-inspector-scale|comment-author-delete|private-media|article-media|public-article-media)
    bootstrap_admin FSUSBLOG_TEST_AUTHOR_BOOTSTRAP browser-author ;;
  *) [[ ${FSUSBLOG_TEST_PUBLIC_FIXTURE:-1} == 1 ]] && bootstrap_admin FSUSBLOG_TEST_AUTHOR_BOOTSTRAP browser-author ;;
esac
case "$flow" in
  workspace-recovery|workspace-split|article-library|property-history|canvas-scale)
    bootstrap_admin FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP "$flow-outsider" ;;
esac
if [[ $flow == comment-author-delete ]]; then
  export FSUSBLOG_TEST_COMMENT_DELETE_DB="$scratch/socket" FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true
fi
if [[ $media_flow == 1 ]]; then
  bootstrap_admin FSUSBLOG_TEST_MOBILE_BOOTSTRAP mobile-author
  if [[ ${FSUSBLOG_TEST_RESUMABLE_MEDIA:-0} == 1 ]]; then
    export FSUSBLOG_PRIVATE_MEDIA_RESUMABLE=true
    if [[ $flow == private-media ]]; then bootstrap_admin FSUSBLOG_TEST_MEDIA_SWITCH_BOOTSTRAP switch-author; fi
  else
    export FSUSBLOG_PRIVATE_MEDIA_RESUMABLE=false
  fi
  make_media_dir FSUSBLOG_PRIVATE_MEDIA_ROOT media
fi
if [[ $flow == public-article-media ]]; then make_media_dir FSUSBLOG_PUBLIC_MEDIA_ROOT public-media; fi
if [[ ${FSUSBLOG_TEST_PUBLIC_FIXTURE:-1} == 1 ]]; then
  fixture_count=$([[ $flow == search-corpus-reuse ]] && echo 220 || echo 12)
  db -v "fixture_count=$fixture_count" -f tests/EndToEnd/public-fixture.sql -f tests/Fixtures/publication-rights.sql > "$evidence/public-fixture.log"
  shasum -a 256 tests/EndToEnd/public-fixture.sql tests/Fixtures/publication-rights.sql >> "$evidence/run.txt"
  export FSUSBLOG_TEST_PUBLIC_FIXTURE=1
fi
if [[ $flow == public-hot-articles ]]; then
  [[ ${FSUSBLOG_TEST_PUBLIC_FIXTURE:-0} == 1 ]]
  export FSUSBLOG_TEST_HOT_ENABLED=${FSUSBLOG_TEST_HOT_ENABLED:-1}
  case "$FSUSBLOG_TEST_HOT_ENABLED" in
    0) export FSUSBLOG_PUBLIC_HOT_ARTICLES=false ;;
    1) export FSUSBLOG_PUBLIC_HOT_ARTICLES=true ;;
    *) exit 2 ;;
  esac
  db -f tests/EndToEnd/public-hot-fixture.sql >> "$evidence/public-fixture.log"
  shasum -a 256 tests/EndToEnd/public-hot-fixture.sql >> "$evidence/run.txt"
fi

http_port=$(node --input-type=module <<'JS'
import { createServer } from 'node:net'
const listener = createServer().listen(0, '127.0.0.1', () => {
  console.log(listener.address().port)
  listener.close()
})
JS
)
url="http://localhost:$http_port"
export FSUSBLOG_ADMIN_ORIGIN="$url" FSUSBLOG_ADMIN_RP_ID=localhost
reader_registration=0
if [[ $flow == comment-author-delete || $flow == reader-registration ||
  ( $flow == public-route-transition && ${FSUSBLOG_TEST_AUTH_TRANSITIONS:-0} == 1 ) ]]; then
  reader_registration=1
  export FSUSBLOG_READER_REGISTRATION=true
fi
if [[ $reader_registration == 1 || $flow == passkey || $flow == site-sessions || $flow == mfa ]]; then
  export FSUSBLOG_PASSKEY_ORIGIN="$url" FSUSBLOG_PASSKEY_RP_ID=localhost
fi
if [[ $flow == search-corpus-reuse ]]; then
  export FSUSBLOG_PUBLIC_SEARCH_MODE=auto
fi
if [[ $flow == mfa ]]; then export FSUSBLOG_TOTP_KEY_HEX="$(openssl rand -hex 32)"; fi
dotnet "$scratch/server/FsusBlog.V2.Server.dll" --urls "http://127.0.0.1:$http_port" > "$evidence/server.log" 2>&1 &
server_pid=$!
for (( attempt=0; attempt<100; attempt++ )); do
  if curl --silent --fail "$url/health/ready" >/dev/null; then break; fi
  kill -0 "$server_pid"
  sleep 0.2
done
curl --silent --fail "$url/health/ready" >/dev/null
export FSUSBLOG_TEST_URL="$url"
if [[ ${FSUSBLOG_TEST_MEDIA_WEBP:-0} == 1 ]]; then
  if "${migrate[@]}" media-webp schema > "$evidence/media-webp-live-rejection.log" 2>&1; then
    echo 'A live serving process must reject the WebP schema upgrade.' >&2
    exit 1
  fi
  rg -q 'Stop the serving process before changing the database schema.' "$evidence/media-webp-live-rejection.log"
fi
case "$flow" in
  canvas-scale)
    node tests/EndToEnd/run-canvas-scale.mjs
    db -f tests/EndToEnd/canvas-scale-verify.sql > "$evidence/canvas-scale-database.txt"
    ;;
  reader-registration) FSUSBLOG_TEST_PASSKEY_URL="$url" node tests/EndToEnd/reader-registration-flow.mjs ;;
  passkey) FSUSBLOG_TEST_PASSKEY_URL="$url" FSUSBLOG_TEST_PASSKEY_TICKET="$FSUSBLOG_TEST_TICKET" node tests/EndToEnd/passkey-flow.mjs ;;
  site-sessions)
    foreign_ticket=$("${migrate[@]}" operator standalone-session-reader --reader)
    FSUSBLOG_TEST_SESSIONS_URL="$url" FSUSBLOG_TEST_SESSIONS_TICKETS=$(printf '["%s","%s"]' "$FSUSBLOG_TEST_TICKET" "$foreign_ticket") \
      node tests/EndToEnd/site-sessions-flow.mjs
    ;;
  mfa) FSUSBLOG_TEST_MFA_URL="$url" FSUSBLOG_TEST_MFA_TICKET="$FSUSBLOG_TEST_TICKET" node tests/EndToEnd/mfa-flow.mjs ;;
  public-hot-articles) node tests/EndToEnd/run-public-hot-articles.mjs ;;
  property-inspector-scale) node tests/EndToEnd/property-inspector-scale.mjs ;;
  canvas-keyboard|article-media|public-article-media|search-corpus-reuse|editor-readiness|workspace-recovery|workspace-split|article-library|property-history|comment-author-delete|site-locale|workspace-locale|public-route-transition)
    node "tests/EndToEnd/${flow}-flow.mjs"
    ;;
  private-media)
    node tests/EndToEnd/private-media-flow.mjs
    if [[ ${FSUSBLOG_TEST_RESUMABLE_MEDIA:-0} == 1 ]]; then
      db -qAt -c 'SELECT (SELECT count(*) FROM public.private_media_upload WHERE complete), (SELECT count(*) FROM public.private_media_upload_part), (SELECT count(*) FROM public.private_media WHERE phase=3)' > "$evidence/media-state.txt"
      [[ $(cat "$evidence/media-state.txt") == '3|0|3' ]]
    fi
    ;;
  *) node tests/EndToEnd/blog-flow.mjs ;;
esac
