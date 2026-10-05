#!/usr/bin/bash
# Explicit original CLI caller only. No outer unit, SDK probe or retry.
# Fresh held-mount-selection candidate; original owner/argv/env/budgets and child umask 022 unchanged.
set -u
set -o noclobber
umask 077
export GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1
fail() { printf 'Original CLI caller refused: %s\n' "$1" >&2; exit 1; }
[ "$#" -eq 3 ] && [ "$1" = EXECUTE_ORIGINAL_CLI ] || fail 'explicit execution mode, task path and new run ID required'
task=$2
run=$3
[[ "$task" =~ ^/home/debian/fsusblog-preparation-v6\.[A-Za-z0-9]{6}$ ]] || fail 'not this task input shape'
[[ "$run" =~ ^guest-original-preparation-v6-[0-9]{8}T[0-9]{6}Z$ ]] || fail 'explicit newly allocated run ID required'
repo=$task/source
sdk=/mnt/fsusblog-qa-sdk
feed=$task/feed
node=/home/debian/task-b8f-20260929/bin/node
feed_digest=9cb2d74e25ad7d950c93cc499aa4e2366fe835b6f45d379f1f65bcd6f89f9bdf
[ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] && [ "$(id -un)" = debian ] || fail 'genuine guest Debian user required'
for input in "$task" "$repo" "$repo/.git" "$sdk" "$feed"; do
  [ -d "$input" ] && [ "$(readlink -f "$input")" = "$input" ] || fail 'noncanonical input'
done
[ "$(findmnt -n -o FSTYPE --target "$repo")" = ext4 ] || fail 'source is not task ext4'
[ ! -e "$repo/.git/objects/info/alternates" ] || fail 'external Git dependency'
[ "$(git -C "$repo" rev-parse HEAD)" = 19ddb3f823dcb1c660d60b5ec3cb2914d7b2f7ef ] || fail 'head drift'
[ "$(git -C "$repo" rev-parse 'HEAD^{tree}')" = b116042d9ff9e552ac1830f5bc67d6396b3d3762 ] || fail 'tree drift'
[ -z "$(git -C "$repo" status --porcelain)" ] || fail 'tracked source drift'
for pair in "qa-sdk:$sdk" "qa-feed:$feed"; do
  tag=${pair%%:*}; target=${pair#*:}
  [ "$(findmnt -n -o SOURCE --mountpoint "$target")" = "$tag" ] || fail 'input mount source drift'
  [ "$(findmnt -n -o FSTYPE --mountpoint "$target")" = 9p ] || fail 'input mount type drift'
  options=$(findmnt -n -o OPTIONS --mountpoint "$target")
  [[ ",$options," = *,ro,* ]] && [[ ",$options," != *,rw,* ]] || fail 'input mount not readonly'
done
[ -x "$node" ] && [ "$(readlink -f "$node")" = "$node" ] || fail 'Node input missing/aliased'
[ "$(sha256sum "$node" | cut -d ' ' -f 1)" = b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd ] || fail 'Node input bytes drift'
[ -x "$sdk/dotnet" ] && [ -r "$repo/tools/docs/prepare-behavior-doc-nuget.mjs" ] || fail 'original input missing'
[ -S /run/user/1000/bus ] && [ "$(stat -c %u /run/user/1000/bus)" = 1000 ] || fail 'actual user bus missing'
for output in "$repo/.tmp" "$repo/.git/production-fresh-exclusive-leases"; do
  [ -d "$output" ] && [ -w "$output" ] && [ "$(readlink -f "$output")" = "$output" ] || fail 'task output/lease shape drift'
done
descriptor="$repo/.tmp/behavior-doc-nuget-preparation/$run.json"
[ ! -e "$descriptor" ] && [ ! -L "$descriptor" ] || fail 'descriptor already exists; no retry'
raw=$task/original-cli-$run
mkdir -m 0700 "$raw" || fail 'new raw directory required'
cd "$repo" || fail 'cannot enter source'
git rev-parse HEAD 'HEAD^{tree}' > "$raw/source-before.txt" || fail 'cannot retain source identity'
printf '%s\n' "run=$run" "source=$repo" "feed=$feed" "feedDigest=$feed_digest" "descriptor=$descriptor" "stdout=$raw/stdout.log" "stderr=$raw/stderr.log" > "$raw/navigation.txt" || fail 'cannot retain navigation'
child= signals=0 pending=
forward() {
  signals=$((signals + 1)); pending=$1
  if [ -n "$child" ]; then kill -s "$1" "$child" 2>/dev/null || :; fi
}
trap 'forward TERM' TERM
trap 'forward INT' INT
# Original CLI owns lease/capacity/current native isolation and all products.
# Root must review actual current platform/resource observations before invoking
# this explicit mode. This word is not a capability or an admission receipt.
(
  # Record this kernel process before exec. exec keeps PID/startticks; the
  # separate cancellation observer must still verify actual Node exe/argv.
  node_pid=$BASHPID
  node_stat=$(< "/proc/$node_pid/stat") || exit 125
  node_stat_tail=${node_stat##*) }
  read -r -a node_fields <<< "$node_stat_tail"
  [ "${#node_fields[@]}" -ge 20 ] || exit 125
  printf '%s\n' "$node_pid" > "$raw/node-pid.txt" || exit 125
  printf '%s\n' "${node_fields[19]}" > "$raw/node-startticks.txt" || exit 125
  printf '%s\n' "$node" > "$raw/node-executable-path.txt" || exit 125
  printf '%s\n' "$repo/tools/docs/prepare-behavior-doc-nuget.mjs" > "$raw/node-module-path.txt" || exit 125
  # Raw directory/files/navigation were created under the unchanged parent 077.
  # Preserve original sealed 0444 feed modes during original CLI staging.
  umask 022
  exec /usr/bin/env -i HOME=/home/debian USER=debian LOGNAME=debian LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    DOTNET_ROOT="$sdk" PATH="$sdk:$(dirname "$node"):/usr/bin:/bin" \
    "$node" "$repo/tools/docs/prepare-behavior-doc-nuget.mjs" \
    --run-id "$run" --out "$descriptor" --feed-root "$feed" --feed-digest "$feed_digest"
) > "$raw/stdout.log" 2> "$raw/stderr.log" &
child=$!
if [ -n "$pending" ]; then kill -s "$pending" "$child" 2>/dev/null || :; fi
while :; do
  before=$signals
  wait "$child"; status=$?
  [ "$signals" -ne "$before" ] || break
done
trap - TERM INT
observation_failed=0
printf '%s\n' "$status" > "$raw/exit-code.txt" || observation_failed=1
git rev-parse HEAD 'HEAD^{tree}' > "$raw/source-after.txt" || observation_failed=1
git status --porcelain > "$raw/source-after-status.txt" || observation_failed=1
printf 'Original CLI actual exit=%s raw=%s; descriptor is not admission PASS\n' "$status" "$raw"
# Preserve original nonzero status. A successful child with source drift is a
# separate operational failure, not permission to consume its output.
[ "$status" -eq 0 ] || exit "$status"
[ "$observation_failed" -eq 0 ] || exit 1
cmp "$raw/source-before.txt" "$raw/source-after.txt" || exit 1
[ ! -s "$raw/source-after-status.txt" ] || exit 1
exit 0
