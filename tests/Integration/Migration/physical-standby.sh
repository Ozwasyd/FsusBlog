#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -c 0
if [[ $# -lt 2 || $# -gt 3 || ! -d "$1" || -e "$2" || ( $# == 3 && "$3" != --rejoin ) ]]; then
  printf 'Usage: %s RELEASE_DIRECTORY NEW_EVIDENCE_DIRECTORY [--rejoin]\n' "$0" >&2
  exit 2
fi
rejoin=0
if [[ ${3:-} == --rejoin ]]; then rejoin=1; fi
fixture=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd "$fixture/../../.." && pwd -P)
release=$(cd "$1" && pwd -P)
mkdir "$2"
evidence=$(cd "$2" && pwd -P)
dotnet=${DOTNET_BIN:-dotnet}
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then export PATH="$PG_TOOLS_DIR:$PATH"; fi
for executable in "$dotnet" initdb pg_ctl postgres pg_basebackup pg_verifybackup psql git tar shasum node curl; do
  command -v "$executable" >/dev/null
done
if ((rejoin)); then
  command -v pg_rewind >/dev/null
  command -v pg_controldata >/dev/null
fi
exec > "$evidence/run.log" 2>&1
run=$(mktemp -d /tmp/fsus-failover.XXXXXXXX)
payload="$run/payload"
export LANG=C LC_ALL=C
# The test only connects to its Unix sockets. Ignore ambient libpq and server configuration.
for variable in "${!PG@}"; do unset "$variable"; done
export PGDATABASE=postgres PGUSER=fsusqa PGCONNECT_TIMEOUT=1
port=54847
primary_sock="$run/pri"
standby_sock="$run/rep"
primary_live=0
standby_live=0
primary_app=
standby_app=
primary_origin=
standby_origin=
cleanup() {
  local status=$? bad=0 app pid app_exit
  trap - EXIT INT TERM
  set +e
  for app in standby primary; do
    if [[ "$app" == standby ]]; then pid=$standby_app; else pid=$primary_app; fi
    if [[ -n "$pid" ]]; then
      if [[ "$(ps -o ppid= -p "$pid" | tr -d ' ')" == "$$" ]]; then kill "$pid"; fi
      wait "$pid" 2>/dev/null
      app_exit=$?
      printf '%s_app_exit=%s\n' "$app" "$app_exit"
      if ((app_exit != 0 && status == 0)); then status=1; fi
      kill -0 "$pid" 2>/dev/null && bad=1
    fi
  done
  if ((standby_live)) || [[ -f "$run/standby/postmaster.pid" ]]; then pg_ctl -D "$run/standby" -m fast -w stop >/dev/null || bad=1; fi
  if ((primary_live)) || [[ -f "$run/primary/postmaster.pid" ]]; then pg_ctl -D "$run/primary" -m fast -w stop >/dev/null || bad=1; fi
  for socket in "$primary_sock" "$standby_sock"; do [[ ! -S "$socket/.s.PGSQL.$port" ]] || bad=1; done
  for origin in "$primary_origin" "$standby_origin"; do
    if [[ -n "$origin" ]] && curl -sS --max-time 1 "$origin/health/ready" >/dev/null 2>&1; then bad=1; fi
  done
  if ((status)); then
    for logfile in "$evidence/primary-server.log" "$evidence/standby-server.log"; do
      if [[ -f "$logfile" ]]; then tail -10 "$logfile"; fi
    done
  fi
  if ((bad == 0 && status == 0)); then find "$run" -depth -delete || bad=1; fi
  if ((bad)); then printf 'cleanup=failed scratch=%s\n' "$run"
  elif ((status)); then printf 'cleanup=yes scratch_retained=%s\n' "$run"
  else printf 'cleanup=yes\n'; fi
  printf 'exit=%s\n' "$status"
  exit "$((status || bad))"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$primary_sock" "$standby_sock" "$payload"
(
  cd "$release"
  shasum -a 256 -c SHA256SUMS
)
tar -xzf "$release/fsusblog-v2.tar.gz" -C "$payload"
(cd "$payload" && shasum -a 256 -c "$release/payload.sha256") > "$evidence/payload-verification.log"
candidate=$(sed -n 's/^fsusblog_commit=//p' "$payload/release.txt")
[[ $candidate =~ ^[0-9a-f]{40}$ ]]
git -C "$repo" archive "$candidate" src/Contracts | tar -xf - -C "$run"
printf 'candidate=%s\n' "$candidate"
shasum -a 256 "$fixture/physical-standby.sh" "$fixture/physical-standby.mjs" "$release/payload.sha256"
postgres --version
node --version
"$dotnet" --list-runtimes
initdb -D "$run/primary" -U fsusqa --auth-local=trust --auth-host=reject --locale=C -E UTF8 --data-checksums > "$evidence/init.log"
rejoin_pg_options=
if ((rejoin)); then rejoin_pg_options=' -c wal_keep_size=128MB'; fi
start_pg() {
  pg_ctl -D "$1" -l "$2" -o "-c listen_addresses='' -k $3 -p $port -c unix_socket_permissions=0700$rejoin_pg_options" -w -t 15 start
}
q() { PGHOST="$1" PGPORT="$port" psql -XAtw -v ON_ERROR_STOP=1 -c "$2"; }
dsn() { printf 'Host=%s;Port=%s;Database=postgres;Username=fsusqa;SSL Mode=Disable;Timeout=1' "$1" "$port"; }
run_app() {
  exec env -i PATH="$PATH" LC_ALL=C FSUSBLOG_DB="$(dsn "$1")" FSUSBLOG_WEB_DIST="$payload/web" \
    "$dotnet" "$payload/server/FsusBlog.V2.Server.dll" --urls http://127.0.0.1:0
}
launch() {
  (run_app "$1") > "$2" 2>&1 &
  launched_pid=$!
}
wait_ready() {
  for ((attempt=0; attempt<80; attempt++)); do
    launched_origin=$(sed -nE 's/^[[:space:]]*Now listening on: (http:\/\/127\.0\.0\.1:[0-9]+)$/\1/p' "$1")
    if [[ -n "$launched_origin" ]] && [[ "$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' "$launched_origin/health/ready")" == 204 ]]; then return; fi
    kill -0 "$launched_pid"
    sleep .15
  done
  return 1
}
start_pg "$run/primary" "$evidence/primary-postgres.log" "$primary_sock"
primary_live=1
migrate=(env -i PATH="$PATH" LC_ALL=C FSUSBLOG_DB="$(dsn "$primary_sock")" "$dotnet" "$payload/cli/FsusBlog.V2.Cli.dll")
"${migrate[@]}" plan > "$run/plan.json"
"${migrate[@]}" apply "$run/plan.json"
"${migrate[@]}" verify
"${migrate[@]}" operator standby-fixture-author > "$run/ticket"
PGHOST="$primary_sock" PGPORT="$port" pg_basebackup --no-password --checkpoint=fast --pgdata="$run/standby" -R -X stream
pg_verifybackup "$run/standby"
start_pg "$run/standby" "$evidence/standby-postgres.log" "$standby_sock"
standby_live=1
streaming="select pg_is_in_recovery()
  and coalesce((select status='streaming' from pg_stat_wal_receiver),false)"
for ((attempt=0; attempt<40; attempt++)); do
  if [[ "$(q "$standby_sock" "$streaming")" == t ]]; then break; fi
  sleep .15
done
[[ "$(q "$standby_sock" "$streaming")" == t ]]
if ((rejoin)); then
  system_id=$(q "$primary_sock" 'select system_identifier from pg_control_system()')
  [[ $system_id =~ ^[0-9]+$ && "$(q "$standby_sock" 'select system_identifier from pg_control_system()')" == "$system_id" ]]
  [[ "$(q "$primary_sock" 'show data_checksums')" == on && "$(q "$primary_sock" 'show full_page_writes')" == on ]]
  [[ "$(q "$primary_sock" 'show wal_keep_size')" == 128MB ]]
  printf 'shared_postgres_system_identifier=%s\n' "$system_id"
fi
if (run_app "$standby_sock") > "$evidence/recovery-denial.log" 2>&1; then exit 6; fi
grep -Fq 'The dedicated PostgreSQL session did not confirm lease ownership.' "$evidence/recovery-denial.log"
if grep -Fq 'Now listening on:' "$evidence/recovery-denial.log"; then exit 7; fi
printf 'unpromoted_startup=refused\n'
launch "$primary_sock" "$evidence/primary-server.log"
primary_app=$launched_pid
wait_ready "$evidence/primary-server.log"
primary_origin=$launched_origin
node "$fixture/physical-standby.mjs" "$run" write - "$primary_origin" "$run/ticket" "$run/receipt.json"
boundary=$(q "$primary_sock" "select pg_current_wal_flush_lsn()")
[[ $boundary =~ ^[0-9A-F]+/[0-9A-F]+$ ]]
for ((attempt=0; attempt<80; attempt++)); do
  if [[ "$(q "$standby_sock" "select pg_last_wal_replay_lsn() >= '$boundary'::pg_lsn")" == t ]]; then break; fi
  sleep .15
done
[[ "$(q "$standby_sock" "select pg_last_wal_replay_lsn() >= '$boundary'::pg_lsn")" == t ]]
old_timeline=$(q "$primary_sock" 'select timeline_id from pg_control_checkpoint()')
replay_lsn=$(q "$standby_sock" 'select pg_last_wal_replay_lsn()')
printf 'required_flush_lsn=%s standby_replay_lsn=%s initial_timeline=%s\n' "$boundary" "$replay_lsn" "$old_timeline"
divergent_id=58c7274b-1d26-45b8-ab32-58c67ed99ca0
if ((rejoin)); then
  # Stop the synced standby before a test-only local marker creates old-timeline divergence.
  pg_ctl -D "$run/standby" -m fast -w -t 15 stop
  standby_live=0
  [[ ! -S "$standby_sock/.s.PGSQL.$port" ]]
  q "$primary_sock" "insert into blog_user(id,name,enabled,generation)
    values('$divergent_id','discarded old timeline fixture',false,1)" >/dev/null
  divergent_lsn=$(q "$primary_sock" 'select pg_current_wal_flush_lsn()')
  [[ $divergent_lsn =~ ^[0-9A-F]+/[0-9A-F]+$ ]]
  [[ "$(q "$primary_sock" "select pg_current_wal_flush_lsn() > '$boundary'::pg_lsn")" == t ]]
  printf 'old_timeline_fixture_committed=yes divergent_flush_lsn=%s\n' "$divergent_lsn"
fi
# The owned primary has no TCP listener. Confirm postmaster exit, socket removal and lost
# readiness in the still-running old Kestrel before enabling the separately restarted app.
primary_pid=$(head -n 1 "$run/primary/postmaster.pid")
pg_ctl -D "$run/primary" -m fast -w -t 15 stop
primary_live=0
[[ ! -S "$primary_sock/.s.PGSQL.$port" ]]
if kill -0 "$primary_pid" 2>/dev/null; then exit 1; fi
for ((attempt=0; attempt<35; attempt++)); do
  if [[ "$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "$primary_origin/health/ready")" == 503 ]]; then break; fi
  sleep .1
done
[[ "$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "$primary_origin/health/ready")" == 503 ]]
kill -0 "$primary_app"
if ((rejoin)); then
  start_pg "$run/standby" "$evidence/standby-postgres.log" "$standby_sock"
  standby_live=1
  [[ "$(q "$standby_sock" "select pg_is_in_recovery()
    and not exists(select from blog_user where id='$divergent_id')")" == t ]]
fi
pg_ctl -D "$run/standby" -w -t 15 promote
[[ "$(q "$standby_sock" 'select pg_is_in_recovery()')" == f ]]
q "$standby_sock" 'checkpoint' >/dev/null
promotion_timeline=$(q "$standby_sock" 'select timeline_id from pg_control_checkpoint()')
((promotion_timeline > old_timeline))
printf 'primary_process_fenced=yes fallback_ready=503 promoted_timeline=%s\n' "$promotion_timeline"
launch "$standby_sock" "$evidence/standby-server.log"
standby_app=$launched_pid
wait_ready "$evidence/standby-server.log"
standby_origin=$launched_origin
node "$fixture/physical-standby.mjs" "$run" compare "$primary_origin" "$standby_origin" "$run/receipt.json" > "$evidence/http-result.json"
q "$standby_sock" "select (select count(*) from article_command)=3
  and (select count(*) from article_revision)=3
  and (select count(*) from article_publication)=0
  and (select count(*) from article_publication_history where kind='publish')=1
  and (select count(*) from blog_outbox where kind='retract')=1
  and (select count(*) from article where published_revision is null)=1" | grep -qx t
printf 'database_command_count=3 revision_count=3 public_pointer_count=0 publication_history_count=1 retraction_event_count=1\n'

if ((rejoin)); then
  [[ ! -e "$run/primary/postmaster.pid" && ! -S "$primary_sock/.s.PGSQL.$port" ]]
  [[ "$(q "$standby_sock" 'select not pg_is_in_recovery()')" == t ]]
  pg_controldata "$run/primary" > "$evidence/rewind-target-control.txt"
  grep -Eq '^Database cluster state:[[:space:]]+shut down$' "$evidence/rewind-target-control.txt"
  q "$standby_sock" 'checkpoint' >/dev/null
  pg_rewind --no-ensure-shutdown --progress --write-recovery-conf --target-pgdata="$run/primary" \
    --source-server="host=$standby_sock port=$port user=$PGUSER dbname=$PGDATABASE application_name=fsus-rejoined" > "$evidence/rewind.log" 2>&1
  grep -Fq 'rewinding from last common checkpoint' "$evidence/rewind.log"
  grep -Fq 'Done!' "$evidence/rewind.log"
  [[ -f "$run/primary/standby.signal" && ! -L "$run/primary/standby.signal" ]]
  start_pg "$run/primary" "$evidence/rejoined-postgres.log" "$primary_sock"
  primary_live=1
  receiver="select pg_is_in_recovery()
    and exists(select from pg_stat_wal_receiver where status='streaming'
      and sender_host='$standby_sock' and sender_port=$port and received_tli=$promotion_timeline)
    and not exists(select from blog_user where id='$divergent_id')"
  sender="select exists(select from pg_stat_replication where application_name='fsus-rejoined' and state='streaming')"
  for ((attempt=0; attempt<80; attempt++)); do
    if [[ "$(q "$primary_sock" "$receiver")" == t && "$(q "$standby_sock" "$sender")" == t ]]; then break; fi
    sleep .15
  done
  [[ "$(q "$primary_sock" "$receiver")" == t && "$(q "$standby_sock" "$sender")" == t ]]
  [[ "$(q "$primary_sock" 'select system_identifier from pg_control_system()')" == "$system_id" ]]
  q "$primary_sock" 'select received_tli,sender_host,sender_port,flushed_lsn from pg_stat_wal_receiver' > "$evidence/rejoined-receiver.txt"
  if (run_app "$primary_sock") > "$evidence/rejoined-startup-denial.log" 2>&1; then exit 8; fi
  grep -Fq 'The dedicated PostgreSQL session did not confirm lease ownership.' "$evidence/rejoined-startup-denial.log"
  if grep -Fq 'Now listening on:' "$evidence/rejoined-startup-denial.log"; then exit 9; fi
  kill -0 "$primary_app"
  node "$fixture/physical-standby.mjs" "$run" rejoin "$primary_origin" "$standby_origin" "$run/receipt.json" > "$evidence/rejoined-http-result.json"
  rejoin_lsn=$(q "$standby_sock" 'select pg_current_wal_flush_lsn()')
  [[ $rejoin_lsn =~ ^[0-9A-F]+/[0-9A-F]+$ ]]
  replay="select pg_last_wal_replay_lsn() >= '$rejoin_lsn'::pg_lsn"
  for ((attempt=0; attempt<80; attempt++)); do
    if [[ "$(q "$primary_sock" "$replay")" == t ]]; then break; fi
    sleep .15
  done
  [[ "$(q "$primary_sock" "$replay")" == t ]]
  facts="select jsonb_build_object(
    'articles',(select jsonb_agg(to_jsonb(a) order by id) from article a),
    'revisions',(select jsonb_agg(to_jsonb(r) order by article_id,revision) from article_revision r),
    'commands',(select jsonb_agg(to_jsonb(c) order by actor_id,command_id) from article_command c),
    'publications',(select jsonb_agg(to_jsonb(p) order by article_id,publication_id) from article_publication p),
    'publication_rights',(select jsonb_agg(to_jsonb(r) order by id) from article_publication_rights r),
    'history',(select jsonb_agg(to_jsonb(h) order by article_id,event_no) from article_publication_history h),
    'outbox',(select jsonb_agg(jsonb_build_array(id,article_id,revision,kind) order by id) from blog_outbox))"
  q "$standby_sock" "$facts" > "$evidence/promoted-facts.json"
  q "$primary_sock" "$facts" > "$evidence/rejoined-facts.json"
  cmp "$evidence/promoted-facts.json" "$evidence/rejoined-facts.json"
  shasum -a 256 "$evidence/promoted-facts.json" "$evidence/rejoined-facts.json"
  printf 'old_app_fenced_after_rejoin=yes rejoined_startup=refused former_primary_recovery=yes post_rejoin_flush_lsn=%s rejoined_replay_lsn=%s facts_match=yes\n' \
    "$rejoin_lsn" "$(q "$primary_sock" 'select pg_last_wal_replay_lsn()')"
fi
